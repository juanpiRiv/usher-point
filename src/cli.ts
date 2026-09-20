import { Command } from "commander";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { localConfigPath, resolveApiKey, setApiKey, unsetApiKey } from "./config/api-key";
import { loadConfig } from "./config/load";
import type { JevConfig, TargetConfig } from "./config/schema";
import { classify } from "./routing/classify";
import { decide } from "./routing/decide";
import { checkJevAvailability, decideViaJevModel, probeJevModel } from "./routing/jev-model";
import type { Decision, TaskShape } from "./routing/types";
import { capCandidates, decisionSkillsToMatches, gatherSkillCandidates, selectSkills } from "./skills/select";
import type { SkillMatch } from "./skills/select";
import { buildClaudeCommand } from "./adapters/claude-adapter";
import { buildCodexCommand } from "./adapters/codex-adapter";
import {
  buildOrcaCommand,
  checkOrcaLiveness,
  expandHome,
  refreshOrcaReference,
  resolveOrcaBinary,
  resolveOrcaTarget,
  referenceCachePath,
} from "./adapters/orca-adapter";
import { fetchOrcaSnapshot, findAgentForWorktree, matchesRepoFilter } from "./adapters/orca-watch";
import { formatCommand, runCommand, type CommandSpec } from "./exec/run-command";

type EngineFlag = "heuristic" | "jev" | "auto";

interface SharedFlags {
  repo?: string;
  target?: string;
  worktree?: boolean;
  verbose?: boolean;
  engine?: string;
}

interface ResolvedRoute {
  shape: TaskShape;
  decision: Decision;
  skills: SkillMatch[];
  via: string;
}

function resolveEngineFlag(engine: string | undefined): EngineFlag {
  const value = engine ?? "auto";
  if (value !== "heuristic" && value !== "jev" && value !== "auto") {
    throw new Error(`usher-point: invalid --engine "${value}". Expected one of: heuristic, jev, auto.`);
  }
  return value;
}

/**
 * Resolves the routing decision, choosing between the local heuristic
 * (classify.ts + decide.ts + skills/select.ts) and the optional Jev model
 * (routing/jev-model.ts) per `--engine`:
 *   - heuristic: always use the local rules and skills/select.ts's
 *     keyword-overlap ranking, never call out to Jev.
 *   - jev: always call Jev; fail LOUDLY (throw) if it's unavailable rather
 *     than silently substituting the heuristic — the caller explicitly asked
 *     for Jev.
 *   - auto (default): try Jev first; on ANY failure (disabled, no key,
 *     network error, bad reply) fall back to the heuristic (routing AND
 *     skill selection together — never a mixed state), and always report
 *     which engine actually decided via `via`.
 * An explicit --target flag always wins outright, before any engine runs,
 * exactly as it did before this feature existed, and always uses
 * skills/select.ts for its skill list (there's no routing decision to hand
 * to Jev in that case).
 *
 * When Jev is actually consulted (engine "jev" or "auto"), the candidate
 * skill list is gathered once up front via skills/select.ts's
 * gatherSkillCandidates()/capCandidates() — the raw {name, path, description}
 * list, with no keyword-overlap ranking applied — and handed to Jev as
 * context so it can decide skills in the same call as target/model. If Jev
 * succeeds, its Decision.skills is mapped back to display-ready SkillMatch
 * objects via decisionSkillsToMatches() using that same candidate list,
 * instead of calling selectSkills() at all for that invocation.
 */
async function resolveRoute(
  taskText: string,
  flags: SharedFlags,
  config: JevConfig,
  cwd: string
): Promise<ResolvedRoute> {
  const classifyFlags: Parameters<typeof classify>[1] = {};
  if (flags.repo !== undefined) classifyFlags.repo = flags.repo;
  if (flags.target !== undefined) classifyFlags.target = flags.target;
  if (flags.worktree !== undefined) classifyFlags.worktree = flags.worktree;

  const shape = classify(taskText, classifyFlags, config);

  if (shape.explicitTarget !== undefined) {
    const skills = selectSkills(taskText, cwd);
    return { shape, decision: decide(shape, config), skills, via: "explicit-target-flag" };
  }

  const engine = resolveEngineFlag(flags.engine);

  if (engine === "heuristic") {
    const skills = selectSkills(taskText, cwd);
    return { shape, decision: decide(shape, config), skills, via: "heuristic (forced)" };
  }

  // engine is "jev" or "auto": both may call Jev, so gather the raw candidate
  // skill list once (no ranking) to hand it context.
  const candidates = capCandidates(gatherSkillCandidates(cwd), taskText);

  if (engine === "jev") {
    const availability = checkJevAvailability(config.jevModel);
    if (!availability.available) {
      throw new Error(
        `usher-point: --engine jev was forced but the Jev model is unavailable (${availability.reason}). Refusing to silently fall back to the heuristic — retry with --engine auto or --engine heuristic.`
      );
    }
    const jevDecision = await decideViaJevModel(taskText, config.jevModel, config.targets, candidates);
    if (!jevDecision) {
      throw new Error(
        "usher-point: --engine jev was forced but the Jev model call failed (network error, non-2xx, or an unparseable reply). Refusing to silently fall back to the heuristic — retry with --engine auto or --engine heuristic."
      );
    }
    return {
      shape,
      decision: jevDecision,
      skills: decisionSkillsToMatches(jevDecision.skills, candidates),
      via: `jev-model (${config.jevModel.model})`,
    };
  }

  // engine === "auto"
  const jevDecision = await decideViaJevModel(taskText, config.jevModel, config.targets, candidates);
  if (jevDecision) {
    return {
      shape,
      decision: jevDecision,
      skills: decisionSkillsToMatches(jevDecision.skills, candidates),
      via: `jev-model (${config.jevModel.model})`,
    };
  }
  return {
    shape,
    decision: decide(shape, config),
    skills: selectSkills(taskText, cwd),
    via: "heuristic-fallback (jev-model unavailable)",
  };
}

/**
 * Applies a Jev-supplied modelOverride (if any) on top of a target's
 * configured defaults. Deliberately generic across targets — it only ever
 * touches the generic TargetConfig.defaultModel/defaultEffort fields, never
 * anything codex-specific; codex-adapter.ts just happens to be the only
 * adapter that currently reads those fields back out.
 */
function applyModelOverride(target: TargetConfig, override: Decision["modelOverride"]): TargetConfig {
  if (!override) return target;
  const merged: TargetConfig = { ...target };
  if (override.model !== undefined) merged.defaultModel = override.model;
  if (override.effort !== undefined) merged.defaultEffort = override.effort;
  return merged;
}

function buildCommandSpec(
  config: JevConfig,
  decision: Decision,
  taskText: string,
  cwd: string,
  skills: SkillMatch[]
): CommandSpec {
  switch (decision.target) {
    case "claude-inline":
      return buildClaudeCommand(
        applyModelOverride(config.targets.claudeInline, decision.modelOverride),
        taskText,
        cwd,
        skills
      );
    case "codex-cli":
      return buildCodexCommand(
        applyModelOverride(config.targets.codexCli, decision.modelOverride),
        taskText,
        cwd,
        decision.sandbox
      );
    case "orca-worktree": {
      const orcaTarget = resolveOrcaTarget(config, decision, cwd);
      return buildOrcaCommand(
        applyModelOverride(config.targets.orcaWorktree, decision.modelOverride),
        decision,
        taskText,
        orcaTarget
      );
    }
  }
}

/**
 * Single shared formatter for one skill match line, used by printPlan()
 * below — the one place `route`/`run` output and the REPL's decision
 * printer both go through, so heuristic-sourced (scored) and Jev-sourced
 * (unscored, possibly with a reason) skills render consistently without a
 * second formatting implementation.
 */
function formatSkillMatch(skill: SkillMatch): string {
  const details: string[] = [];
  if (typeof skill.score === "number") details.push(`score ${skill.score}`);
  details.push(skill.source);
  const base = `${skill.name} (${details.join(", ")})`;
  return skill.reason ? `${base}: ${skill.reason}` : base;
}

function printPlan(
  taskText: string,
  cwd: string,
  config: JevConfig,
  shape: ReturnType<typeof classify>,
  decision: Decision,
  skills: SkillMatch[],
  verbose: boolean,
  via: string
): void {
  console.log(`task:   "${taskText}"`);
  // A Jev-model decision has no matched config rule id worth printing —
  // `via:` is the meaningful line there. Heuristic-derived decisions print
  // both, so the matched rule stays visible for debugging.
  if (decision.ruleId.startsWith("jev-model:")) {
    console.log(`via:    ${via}`);
  } else {
    console.log(`rule:   ${decision.ruleId}`);
    console.log(`via:    ${via}`);
  }
  console.log(`target: ${decision.target}`);
  if (decision.repoName) {
    console.log(`repo:   ${decision.repoName}`);
  }

  if (decision.target === "orca-worktree") {
    const orcaTarget = resolveOrcaTarget(config, decision, cwd);
    console.log(`worktree root: ${orcaTarget.worktreeRoot}${orcaTarget.repoKnown ? "" : " (unknown repo, using cwd)"}`);
    console.log(`agent:  ${decision.spawnAgent ?? "codex"}`);
  }

  console.log(
    `skills: ${skills.length > 0 ? skills.map(formatSkillMatch).join(", ") : "(none matched)"}`
  );

  if (decision.modelOverride) {
    const bits: string[] = [];
    if (decision.modelOverride.model !== undefined) bits.push(`model=${decision.modelOverride.model}`);
    if (decision.modelOverride.effort !== undefined) bits.push(`effort=${decision.modelOverride.effort}`);
    console.log(`model override: ${bits.length > 0 ? bits.join(", ") : "(none)"}`);
  }

  try {
    const spec = buildCommandSpec(config, decision, taskText, cwd, skills);
    console.log(`command: ${formatCommand(spec)}`);
  } catch (err) {
    console.log(`command: <unavailable> — ${(err as Error).message}`);
  }

  if (verbose) {
    console.log("--- task shape ---");
    console.log(JSON.stringify(shape, null, 2));
    if (decision.reasoning !== undefined) {
      console.log("--- jev-model reasoning ---");
      console.log(`confidence: ${decision.confidence ?? "unknown"}`);
      console.log(decision.reasoning);
    }
  }
}

function readVersion(): string {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Splits one REPL input line into a task description plus the three flags the
 * interactive loop supports inline (--repo, --target, --engine — the same
 * flags `route`/`run` accept). This is a deliberately minimal, purpose-built
 * split, not a second copy of commander's parser: a REPL line arrives as
 * plain text (no shell involved), so there is no quoting/escaping to
 * reproduce — tokens are just whitespace-separated.
 */
function parseReplLine(line: string): { taskText: string; flags: SharedFlags } {
  const tokens = line.split(/\s+/).filter((t) => t.length > 0);
  const flags: SharedFlags = {};
  const remaining: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const next = tokens[i + 1];
    if (tok === "--repo" && next !== undefined) {
      flags.repo = next;
      i++;
    } else if (tok === "--target" && next !== undefined) {
      flags.target = next;
      i++;
    } else if (tok === "--engine" && next !== undefined) {
      flags.engine = next;
      i++;
    } else {
      remaining.push(tok as string);
    }
  }

  return { taskText: remaining.join(" "), flags };
}

/**
 * Interactive REPL for bare `usher`/`usher-point` invocations (no subcommand,
 * no args) — the same UX pattern as `claude` with no args opening a chat
 * session. Reuses `resolveRoute`/`printPlan`/`buildCommandSpec`/`runCommand`
 * exactly as `route`/`run` do; it does not duplicate routing, formatting, or
 * execution logic. `route`/`run`/`doctor` remain unchanged for scripted use.
 */
function runRepl(): void {
  const config = loadConfig();
  const cwd = process.cwd();

  console.log(`usher-point v${readVersion()} — interactive mode.`);
  console.log('Type a task description, or "exit"/"quit"/Ctrl+D to leave.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("usher> ");
  // readline only intercepts Ctrl+C as an interface-level "SIGINT" event when
  // stdin is an interactive TTY in raw mode; on a piped/non-TTY stdin (or a
  // signal sent directly to the process) Node's default SIGINT handling would
  // otherwise terminate with a signal exit code, so handle both.
  rl.on("SIGINT", () => rl.close());
  process.on("SIGINT", () => rl.close());

  // Set between printing a decision and reading the y/N confirmation for it.
  let pending: { decision: Decision; skills: SkillMatch[]; taskText: string } | null = null;

  rl.prompt();

  // readline emits every already-buffered "line" event synchronously as soon
  // as a chunk arrives (pause()/resume() only affects *future* reads, not
  // lines already parsed out of the current chunk) — piped stdin routinely
  // delivers several lines in one chunk. Queue lines and drain them one at a
  // time so an earlier line's async routing/run work always finishes before
  // a later line (e.g. "exit") is handled.
  let closed = false;
  const queue: string[] = [];
  let draining = false;

  async function drainQueue(): Promise<void> {
    if (draining) return;
    draining = true;
    while (queue.length > 0 && !closed) {
      const rawLine = queue.shift() as string;
      await handleLine(rawLine);
    }
    draining = false;
  }

  rl.on("line", (rawLine: string) => {
    queue.push(rawLine);
    void drainQueue();
  });

  rl.on("close", () => {
    closed = true;
    console.log("\nGoodbye.");
    process.exit(0);
  });

  function safePrompt(): void {
    if (!closed) rl.prompt();
  }

  async function handleLine(rawLine: string): Promise<void> {
    const line = rawLine.trim();

    if (pending) {
      const { decision, skills, taskText } = pending;
      pending = null;
      const answer = line.toLowerCase();
      if (answer === "y" || answer === "yes") {
        try {
          const spec = buildCommandSpec(config, decision, taskText, cwd, skills);
          console.log(`\n> launching: ${formatCommand(spec)}\n`);
          const exitCode = await runCommand(spec);
          console.log(`(exited with code ${exitCode})`);
        } catch (err) {
          console.error((err as Error).message);
        }
      }
      rl.setPrompt("usher> ");
      safePrompt();
      return;
    }

    if (line === "") {
      safePrompt();
      return;
    }
    if (line === "exit" || line === "quit") {
      rl.close();
      return;
    }

    const { taskText, flags } = parseReplLine(line);
    if (!taskText) {
      console.log("usher-point: please enter a task description.");
      safePrompt();
      return;
    }

    try {
      const { shape, decision, skills, via } = await resolveRoute(taskText, flags, config, cwd);
      printPlan(taskText, cwd, config, shape, decision, skills, false, via);
      pending = { decision, skills, taskText };
      rl.setPrompt("Run this? [y/N] ");
      safePrompt();
    } catch (err) {
      console.error((err as Error).message);
      rl.setPrompt("usher> ");
      safePrompt();
    }
  }
}

function main(): void {
  if (process.argv.length <= 2) {
    // Bare `usher`/`usher-point` — no subcommand, no args — starts the
    // interactive REPL instead of commander's default help/error output.
    runRepl();
    return;
  }

  const program = new Command();
  program.name("usher-point").description("Decide and dispatch a task to claude / codex / orca.");

  const addSharedOptions = (cmd: Command): Command =>
    cmd
      .argument("<task>", "description of the task to route")
      .option("--repo <name>", "known repo name (see usher-point.config.json knownRepos)")
      .option("--target <target>", "force claude-inline | codex-cli | orca-worktree")
      .option("--worktree", "force isolation in a worktree")
      .option("--verbose", "print full task-shape classification")
      .option("--engine <engine>", "heuristic | jev | auto (default: auto — try Jev, fall back to heuristic)", "auto");

  addSharedOptions(program.command("route").description("Dry-run: print the routing decision only")).action(
    async (taskText: string, flags: SharedFlags) => {
      const config = loadConfig();
      const cwd = process.cwd();
      const { shape, decision, skills, via } = await resolveRoute(taskText, flags, config, cwd);
      printPlan(taskText, cwd, config, shape, decision, skills, Boolean(flags.verbose), via);
    }
  );

  addSharedOptions(program.command("run").description("Route the task and actually launch it")).action(
    async (taskText: string, flags: SharedFlags) => {
      const config = loadConfig();
      const cwd = process.cwd();
      const { shape, decision, skills, via } = await resolveRoute(taskText, flags, config, cwd);
      printPlan(taskText, cwd, config, shape, decision, skills, Boolean(flags.verbose), via);

      const spec = buildCommandSpec(config, decision, taskText, cwd, skills);
      console.log(`\n> launching: ${formatCommand(spec)}\n`);
      const exitCode = await runCommand(spec);
      process.exitCode = exitCode;
    }
  );

  program
    .command("doctor")
    .description("Check claude/codex/orca resolve in PATH, the Jev/OpenRouter setup, and refresh the Orca CLI reference cache")
    .action(async () => {
      await runDoctor();
    });

  program
    .command("watch")
    .description(
      "Read-only: poll orca worktree ps/terminal list --json and show live worktree/agent status until Ctrl+C. Never creates or spawns anything."
    )
    .option("--repo <name>", "known repo name (see usher-point.config.json knownRepos) — filter to just that repo's worktree(s)")
    .action((flags: { repo?: string }) => {
      runWatch(flags.repo);
    });

  const configCmd = program
    .command("config")
    .description(
      "Manage the locally stored Jev/OpenRouter API key (~/.config/usher-point/config.json) — never usher-point.config.json, which is versioned"
    );

  configCmd
    .command("set-key [value]")
    .description(
      "Store the API key in ~/.config/usher-point/config.json (mode 600). Omit the argument to read the value from stdin instead of argv."
    )
    .action((value: string | undefined) => {
      setKeyAction(value);
    });

  configCmd
    .command("unset-key")
    .description("Remove the locally stored API key, if any (deletes the file if it becomes empty).")
    .action(() => {
      unsetKeyAction();
    });

  configCmd
    .command("status")
    .description("Report whether an API key is configured and its source, without ever printing the value.")
    .action(() => {
      configStatusAction();
    });

  program.parseAsync(process.argv).catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  });
}

/**
 * `usher-point config set-key [value]` — writes `{ [apiKeyEnvVar]: value }`
 * to ~/.config/usher-point/config.json (mode 600), using whatever
 * `jevModel.apiKeyEnvVar` is configured to in usher-point.config.json as the
 * JSON key name. NEVER prints, logs, or echoes the value back.
 *
 * The value can be given positionally (`config set-key sk-...`) or, if
 * omitted, is read from stdin (`echo sk-... | usher-point config set-key`).
 * Both are supported deliberately: a positional arg is the simplest path
 * for a single-user machine, but it's visible to other local users via `ps`
 * on a shared machine for the process's lifetime — stdin avoids that. See
 * docs/USAGE.md for the full tradeoff.
 */
function setKeyAction(value: string | undefined): void {
  const config = loadConfig();
  const envVarName = config.jevModel.apiKeyEnvVar;

  let key = value;
  if (key === undefined) {
    try {
      key = fs.readFileSync(0, "utf-8").trim();
    } catch (err) {
      console.error(`usher-point: could not read API key from stdin: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }

  if (!key) {
    console.error(
      "usher-point: no API key value given — pass it as an argument (usher-point config set-key <value>) or pipe it via stdin."
    );
    process.exitCode = 1;
    return;
  }

  setApiKey(envVarName, key);
  console.log(`[ok]   ${envVarName} stored in ${localConfigPath()} (mode 600, value not shown).`);
}

/** `usher-point config unset-key` — removes the key; never prints its value. */
function unsetKeyAction(): void {
  const config = loadConfig();
  const envVarName = config.jevModel.apiKeyEnvVar;
  unsetApiKey(envVarName);
  console.log(`[ok]   ${envVarName} removed from ${localConfigPath()} (if it was present).`);
}

/**
 * `usher-point config status` — presence/source only, exactly as safe as
 * `doctor`'s discipline: never the value, never even partial/masked.
 */
function configStatusAction(): void {
  const config = loadConfig();
  const envVarName = config.jevModel.apiKeyEnvVar;
  const resolution = resolveApiKey(envVarName);
  if (resolution.source === "not configured") {
    console.log(`${envVarName}: not configured`);
  } else {
    console.log(`${envVarName}: configured (${resolution.source})`);
  }
}

async function runDoctor(): Promise<void> {
  let hadFailure = false;

  for (const bin of ["claude", "codex", "orca"]) {
    const found = spawnSync("which", [bin], { encoding: "utf-8" });
    if (found.status === 0) {
      console.log(`[ok]   ${bin} -> ${found.stdout.trim()}`);
    } else {
      hadFailure = true;
      console.log(`[fail] ${bin} not found in PATH`);
    }
  }

  const binary = resolveOrcaBinary();
  const liveness = checkOrcaLiveness(binary);
  if (liveness.ok) {
    console.log(`[ok]   orca status --json reachable (app running: ${liveness.running ?? "unknown"})`);
  } else {
    console.log(`[warn] orca status --json did not respond cleanly: ${liveness.error ?? "unknown error"}`);
  }

  try {
    refreshOrcaReference(binary);
    console.log(`[ok]   refreshed Orca CLI reference cache at ${referenceCachePath()}`);
  } catch (err) {
    hadFailure = true;
    console.log(`[fail] could not refresh Orca CLI reference cache: ${(err as Error).message}`);
  }

  // Jev (TypeSafe AI) routing engine — read-only, no-side-effects check, same
  // philosophy as the Orca liveness check above. Never a [fail]: usher-point
  // always still works via the heuristic engine if this is unavailable.
  // Resolution (env var, then ~/.config/usher-point/config.json, then
  // "not configured") is centralized in config/api-key.ts's resolveApiKey —
  // the exact same function `usher-point config status` uses, so this never
  // duplicates the lookup.
  const config = loadConfig();
  const apiKeyEnvVar = config.jevModel.apiKeyEnvVar;
  const resolution = resolveApiKey(apiKeyEnvVar);
  if (resolution.source === "not configured") {
    console.log(
      `[warn] ${apiKeyEnvVar} not set (checked environment variable and ~/.config/usher-point/config.json) — Jev routing engine unavailable; usher-point still works via the heuristic engine`
    );
  } else {
    console.log(`[ok]   ${apiKeyEnvVar} is configured (source: ${resolution.source}; value not shown)`);
    try {
      // Force enabled:true for this probe only, so the live-key check isn't
      // gated on jevModel.enabled in the config — it's testing the key/model,
      // not whether routing is switched on.
      const probe = await probeJevModel(
        "trivial connectivity check: fix a typo in a comment",
        { ...config.jevModel, enabled: true },
        config.targets
      );
      if (probe.ok) {
        console.log(`[ok]   live Jev call succeeded via OpenRouter (model: ${config.jevModel.model}, chose: ${probe.decision.target})`);
      } else {
        console.log(`[warn] live Jev call failed: ${probe.reason}`);
      }
    } catch (err) {
      console.log(`[warn] live Jev call failed unexpectedly: ${(err as Error).message}`);
    }
  }

  process.exitCode = hadFailure ? 1 : 0;
}

const WATCH_POLL_INTERVAL_MS = 2500;

/**
 * `usher-point watch [--repo <name>]` — read-only, explicit-only visibility
 * into what an already-dispatched `orca-worktree` run is doing, since `run`
 * itself only dispatches `orca worktree create ...` and exits once that
 * command returns; it never shows what the spawned agent does afterward.
 * Deliberately a *separate* command, never automatic behavior bolted onto
 * `run` — nothing in usher-point happens unless explicitly asked for.
 *
 * Polls Orca's own read-only introspection commands (`orca worktree ps
 * --json`, `orca terminal list --json`, both via orca-watch.ts's
 * fetchOrcaSnapshot(), which itself only ever uses this same
 * resolveOrcaBinary() — no second binary resolution path) on an interval and
 * redraws. Never creates, modifies, or spawns a worktree/agent itself.
 *
 * On any failure to reach Orca or run those commands, this reports it once,
 * using the exact same doctor-style `orca status --json did not respond
 * cleanly: ...` phrasing (via checkOrcaLiveness() inside fetchOrcaSnapshot),
 * and exits rather than looping forever on an error that will not resolve
 * itself without user action.
 */
function runWatch(repoName: string | undefined): void {
  const config = loadConfig();

  let worktreeRoot: string | undefined;
  if (repoName !== undefined) {
    const known = config.knownRepos[repoName];
    if (!known) {
      console.error(
        `usher-point: unknown repo "${repoName}" — not found in usher-point.config.json's knownRepos.`
      );
      process.exitCode = 1;
      return;
    }
    worktreeRoot = expandHome(known.worktreeRoot);
  }

  const binary = resolveOrcaBinary();
  let timer: NodeJS.Timeout | undefined;

  const stop = (): void => {
    if (timer) clearInterval(timer);
    console.log("\nusher-point watch: stopped.");
    process.exit(0);
  };
  // Same discipline as the REPL's SIGINT handling above: Ctrl+C must exit
  // cleanly (code 0), not with a signal-terminated exit code.
  process.on("SIGINT", stop);

  const tick = (): void => {
    const snapshot = fetchOrcaSnapshot(binary);

    if (process.stdout.isTTY) {
      process.stdout.write("\x1Bc"); // clear + redraw, like `top`
    } else {
      console.log("----");
    }
    console.log(`usher-point watch — ${new Date().toLocaleTimeString()} (Ctrl+C to stop)`);
    if (repoName) console.log(`repo filter: ${repoName}`);
    console.log("");

    if (!snapshot.ok) {
      console.log(`[warn] ${snapshot.reason}`);
      if (timer) clearInterval(timer);
      process.exitCode = 1;
      return;
    }

    const worktrees =
      repoName !== undefined && worktreeRoot !== undefined
        ? snapshot.worktrees.filter((w) => matchesRepoFilter(w, repoName, worktreeRoot as string))
        : snapshot.worktrees;

    if (worktrees.length === 0) {
      console.log(repoName ? `no worktrees reported for repo "${repoName}"` : "no worktrees reported by orca worktree ps --json");
    } else {
      for (const w of worktrees) {
        const agent = findAgentForWorktree(w, snapshot.terminals);
        console.log(`- ${w.name}  status=${w.status}  agent=${agent ?? "(none)"}`);
      }
    }
  };

  tick();
  if (process.exitCode === undefined || process.exitCode === 0) {
    timer = setInterval(tick, WATCH_POLL_INTERVAL_MS);
  }
}

main();
