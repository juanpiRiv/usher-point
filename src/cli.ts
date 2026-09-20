import { Command } from "commander";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { loadConfig } from "./config/load";
import type { JevConfig } from "./config/schema";
import { classify } from "./routing/classify";
import { decide } from "./routing/decide";
import { checkJevAvailability, decideViaJevModel, probeJevModel } from "./routing/jev-model";
import type { Decision, TaskShape } from "./routing/types";
import { selectSkills } from "./skills/select";
import type { SkillMatch } from "./skills/select";
import { buildClaudeCommand } from "./adapters/claude-adapter";
import { buildCodexCommand } from "./adapters/codex-adapter";
import {
  buildOrcaCommand,
  checkOrcaLiveness,
  refreshOrcaReference,
  resolveOrcaBinary,
  resolveOrcaTarget,
  referenceCachePath,
} from "./adapters/orca-adapter";
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
 * (classify.ts + decide.ts) and the optional Jev model (routing/jev-model.ts)
 * per `--engine`:
 *   - heuristic: always use the local rules, never call out to Jev.
 *   - jev: always call Jev; fail LOUDLY (throw) if it's unavailable rather
 *     than silently substituting the heuristic — the caller explicitly asked
 *     for Jev.
 *   - auto (default): try Jev first; on ANY failure (disabled, no key,
 *     network error, bad reply) fall back to the heuristic, and always
 *     report which engine actually decided via `via`.
 * An explicit --target flag always wins outright, before any engine runs,
 * exactly as it did before this feature existed.
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
  const skills = selectSkills(taskText, cwd);

  if (shape.explicitTarget !== undefined) {
    return { shape, decision: decide(shape, config), skills, via: "explicit-target-flag" };
  }

  const engine = resolveEngineFlag(flags.engine);

  if (engine === "heuristic") {
    return { shape, decision: decide(shape, config), skills, via: "heuristic (forced)" };
  }

  if (engine === "jev") {
    const availability = checkJevAvailability(config.jevModel);
    if (!availability.available) {
      throw new Error(
        `usher-point: --engine jev was forced but the Jev model is unavailable (${availability.reason}). Refusing to silently fall back to the heuristic — retry with --engine auto or --engine heuristic.`
      );
    }
    const jevDecision = await decideViaJevModel(taskText, config.jevModel, config.targets);
    if (!jevDecision) {
      throw new Error(
        "usher-point: --engine jev was forced but the Jev model call failed (network error, non-2xx, or an unparseable reply). Refusing to silently fall back to the heuristic — retry with --engine auto or --engine heuristic."
      );
    }
    return { shape, decision: jevDecision, skills, via: `jev-model (${config.jevModel.model})` };
  }

  // engine === "auto"
  const jevDecision = await decideViaJevModel(taskText, config.jevModel, config.targets);
  if (jevDecision) {
    return { shape, decision: jevDecision, skills, via: `jev-model (${config.jevModel.model})` };
  }
  return {
    shape,
    decision: decide(shape, config),
    skills,
    via: "heuristic-fallback (jev-model unavailable)",
  };
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
      return buildClaudeCommand(config.targets.claudeInline, taskText, cwd, skills);
    case "codex-cli":
      return buildCodexCommand(config.targets.codexCli, taskText, cwd, decision.sandbox);
    case "orca-worktree": {
      const orcaTarget = resolveOrcaTarget(config, decision, cwd);
      return buildOrcaCommand(config.targets.orcaWorktree, decision, taskText, orcaTarget);
    }
  }
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
    `skills: ${skills.length > 0 ? skills.map((s) => `${s.name} (score ${s.score}, ${s.source})`).join(", ") : "(none matched)"}`
  );

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

  program.parseAsync(process.argv).catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  });
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
  const config = loadConfig();
  const apiKeyEnvVar = config.jevModel.apiKeyEnvVar;
  const apiKey = process.env[apiKeyEnvVar];
  if (!apiKey) {
    console.log(
      `[warn] ${apiKeyEnvVar} not set — Jev routing engine unavailable; usher-point still works via the heuristic engine`
    );
  } else {
    console.log(`[ok]   ${apiKeyEnvVar} is set (value not shown)`);
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

main();
