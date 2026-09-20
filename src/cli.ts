import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config/load";
import type { JevConfig } from "./config/schema";
import { classify } from "./routing/classify";
import { decide } from "./routing/decide";
import type { Decision } from "./routing/types";
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

interface SharedFlags {
  repo?: string;
  target?: string;
  worktree?: boolean;
  verbose?: boolean;
}

function resolvePlan(taskText: string, flags: SharedFlags, config: JevConfig, cwd: string) {
  const classifyFlags: Parameters<typeof classify>[1] = {};
  if (flags.repo !== undefined) classifyFlags.repo = flags.repo;
  if (flags.target !== undefined) classifyFlags.target = flags.target;
  if (flags.worktree !== undefined) classifyFlags.worktree = flags.worktree;

  const shape = classify(taskText, classifyFlags, config);
  const decision = decide(shape, config);
  const skills = selectSkills(taskText, cwd);
  return { shape, decision, skills };
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
  verbose: boolean
): void {
  console.log(`task:   "${taskText}"`);
  console.log(`rule:   ${decision.ruleId}`);
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
  }
}

function main(): void {
  const program = new Command();
  program.name("jev").description("Decide and dispatch a task to claude / codex / orca.");

  const addSharedOptions = (cmd: Command): Command =>
    cmd
      .argument("<task>", "description of the task to route")
      .option("--repo <name>", "known repo name (see jev.config.json knownRepos)")
      .option("--target <target>", "force claude-inline | codex-cli | orca-worktree")
      .option("--worktree", "force isolation in a worktree")
      .option("--verbose", "print full task-shape classification");

  addSharedOptions(program.command("route").description("Dry-run: print the routing decision only")).action(
    (taskText: string, flags: SharedFlags) => {
      const config = loadConfig();
      const cwd = process.cwd();
      const { shape, decision, skills } = resolvePlan(taskText, flags, config, cwd);
      printPlan(taskText, cwd, config, shape, decision, skills, Boolean(flags.verbose));
    }
  );

  addSharedOptions(program.command("run").description("Route the task and actually launch it")).action(
    async (taskText: string, flags: SharedFlags) => {
      const config = loadConfig();
      const cwd = process.cwd();
      const { shape, decision, skills } = resolvePlan(taskText, flags, config, cwd);
      printPlan(taskText, cwd, config, shape, decision, skills, Boolean(flags.verbose));

      const spec = buildCommandSpec(config, decision, taskText, cwd, skills);
      console.log(`\n> launching: ${formatCommand(spec)}\n`);
      const exitCode = await runCommand(spec);
      process.exitCode = exitCode;
    }
  );

  program
    .command("doctor")
    .description("Check claude/codex/orca resolve in PATH and refresh the Orca CLI reference cache")
    .action(() => {
      runDoctor();
    });

  program.parseAsync(process.argv).catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  });
}

function runDoctor(): void {
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

  process.exitCode = hadFailure ? 1 : 0;
}

main();
