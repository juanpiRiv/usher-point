import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { packageRoot } from "../config/load";
import type { JevConfig, TargetConfig } from "../config/schema";
import type { Decision } from "../routing/types";
import type { CommandSpec } from "../exec/run-command";

/**
 * Orca's own CLI subcommand syntax is NOT hardcoded here — it changes
 * between Orca releases (see the `orca-cli` skill). Instead:
 *   1. Liveness is checked generically via `orca status --json`.
 *   2. The actual worktree-spawn subcommand is treated as data, cached by
 *      `jev doctor` (which runs `orca skills get orca-cli`) into
 *      orca-cli-reference.json (gitignored, refreshed on demand).
 *   3. If that cache is missing, jev fails with a clear "run `jev doctor`"
 *      message instead of guessing at syntax.
 */

export interface OrcaReference {
  fetchedAt: string;
  raw: string;
  /**
   * Best-effort extraction from the raw `orca skills get orca-cli` output.
   * Tokens are substituted at build time: {{task}}, {{cwd}}, {{repo}}.
   * Left undefined when doctor couldn't confidently extract a subcommand —
   * callers must fail closed in that case, never fall back to a guess.
   */
  spawnCommandTemplate?: string[];
}

export function referenceCachePath(): string {
  return path.join(packageRoot(), "orca-cli-reference.json");
}

export function resolveOrcaBinary(): string {
  return process.env["ORCA_CLI_COMMAND"] ?? "orca";
}

export interface OrcaLiveness {
  ok: boolean;
  running: boolean | undefined;
  raw?: string;
  error?: string;
}

export function checkOrcaLiveness(binary: string = resolveOrcaBinary()): OrcaLiveness {
  const result = spawnSync(binary, ["status", "--json"], { encoding: "utf-8" });

  if (result.error) {
    return { ok: false, running: undefined, error: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, running: undefined, raw: result.stdout, error: result.stderr };
  }

  try {
    const parsed = JSON.parse(result.stdout) as { result?: { app?: { running?: boolean } } };
    return { ok: true, running: parsed.result?.app?.running, raw: result.stdout };
  } catch (err) {
    return { ok: false, running: undefined, raw: result.stdout, error: (err as Error).message };
  }
}

/** Runs `orca skills get orca-cli` and refreshes the local reference cache. Used only by `jev doctor`. */
export function refreshOrcaReference(binary: string = resolveOrcaBinary()): OrcaReference {
  const result = spawnSync(binary, ["skills", "get", "orca-cli"], { encoding: "utf-8" });

  if (result.error) {
    throw new Error(`jev: could not run "${binary} skills get orca-cli": ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `jev: "${binary} skills get orca-cli" exited with ${result.status}\n${result.stderr}`
    );
  }

  const raw = result.stdout;
  const reference: OrcaReference = {
    fetchedAt: new Date().toISOString(),
    raw,
  };
  const template = extractSpawnCommandTemplate(raw);
  if (template) reference.spawnCommandTemplate = template;

  fs.writeFileSync(referenceCachePath(), JSON.stringify(reference, null, 2), "utf-8");
  return reference;
}

/**
 * Best-effort, non-authoritative heuristic: look for a fenced code line that
 * looks like an `orca <subcommand> ...` worktree-spawn invocation. This is
 * intentionally conservative — if it can't find a confident match, it
 * returns undefined and callers must fail closed with a "run jev doctor"
 * style error rather than hardcode a guess.
 */
function extractSpawnCommandTemplate(raw: string): string[] | undefined {
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim().replace(/^\$\s*/, "");
    if (!trimmed.startsWith("orca ")) continue;
    if (!/worktree|spawn/i.test(trimmed)) continue;
    return trimmed.split(/\s+/);
  }
  return undefined;
}

export function loadOrcaReference(): OrcaReference {
  const cachePath = referenceCachePath();
  let raw: string;
  try {
    raw = fs.readFileSync(cachePath, "utf-8");
  } catch {
    throw new Error(
      `jev: no Orca CLI reference cache found at ${cachePath}. Run \`jev doctor\` first.`
    );
  }

  try {
    return JSON.parse(raw) as OrcaReference;
  } catch (err) {
    throw new Error(
      `jev: Orca CLI reference cache at ${cachePath} is corrupt (${(err as Error).message}). Run \`jev doctor\` to refresh it.`
    );
  }
}

export interface OrcaTarget {
  worktreeRoot: string;
  repoKnown: boolean;
}

export function resolveOrcaTarget(config: JevConfig, decision: Decision, cwd: string): OrcaTarget {
  if (decision.repoName) {
    const known = config.knownRepos[decision.repoName];
    if (known) {
      return { worktreeRoot: expandHome(known.worktreeRoot), repoKnown: true };
    }
  }
  return { worktreeRoot: cwd, repoKnown: false };
}

/**
 * Builds the real dispatch command from the cached reference. Throws (with a
 * "run `jev doctor`" message) if the cache is missing or has no recognized
 * spawn subcommand — jev never falls back to hardcoded Orca syntax.
 */
export function buildOrcaCommand(
  _target: TargetConfig,
  decision: Decision,
  taskText: string,
  orcaTarget: OrcaTarget
): CommandSpec {
  const reference = loadOrcaReference();
  if (!reference.spawnCommandTemplate) {
    throw new Error(
      `jev: Orca CLI reference cache at ${referenceCachePath()} has no recognized worktree-spawn subcommand. Run \`jev doctor\` to refresh it, or inspect the cache file manually.`
    );
  }

  const binary = resolveOrcaBinary();
  const [, ...templateArgs] = reference.spawnCommandTemplate;
  const args = templateArgs.map((token) =>
    token
      .replace("{{task}}", taskText)
      .replace("{{repo}}", orcaTarget.worktreeRoot)
      .replace("{{cwd}}", orcaTarget.worktreeRoot)
      .replace("{{agent}}", decision.spawnAgent ?? "codex")
  );

  return {
    command: binary,
    args,
    cwd: orcaTarget.worktreeRoot,
    stdin: "ignore",
  };
}

function expandHome(target: string): string {
  if (target === "~") return os.homedir();
  if (target.startsWith("~/")) return path.join(os.homedir(), target.slice(2));
  return target;
}
