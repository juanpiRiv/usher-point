import { spawnSync } from "node:child_process";
import { checkOrcaLiveness, resolveOrcaBinary } from "./orca-adapter";

/**
 * Read-only introspection for `usher-point watch`. This module NEVER creates,
 * modifies, or spawns a worktree/agent — it only shells out to Orca's own
 * read-only `worktree ps --json` / `terminal list --json` commands (the
 * documented fallback introspection commands from the `orca-cli` skill
 * reference, see `orca-cli-reference.json`) and parses their output.
 *
 * Same boundary discipline as `orca-adapter.ts`: `resolveOrcaBinary()` is the
 * one and only binary resolution path (never a second one here), and Orca's
 * own JSON response shape for `worktree ps`/`terminal list` is treated as
 * data, not hardcoded — this module degrades gracefully (falls back to
 * whatever string fields it can find) rather than assuming an exact schema,
 * since that shape has not been observed on a live Orca instance while this
 * was written (see docs/USAGE.md for the honesty note).
 */

export interface OrcaWorktreeRow {
  name: string;
  status: string;
  worktreeId: string | undefined;
  raw: Record<string, unknown>;
}

export interface OrcaTerminalRow {
  handle: string | undefined;
  title: string | undefined;
  worktreeId: string | undefined;
  agentGuess: string | undefined;
  raw: Record<string, unknown>;
}

export interface OrcaSnapshot {
  ok: true;
  worktrees: OrcaWorktreeRow[];
  terminals: OrcaTerminalRow[];
}

export interface OrcaSnapshotFailure {
  ok: false;
  reason: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstArray(...candidates: unknown[]): unknown[] | undefined {
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return undefined;
}

function pickString(obj: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

interface OrcaJsonOk {
  ok: true;
  data: unknown;
}
interface OrcaJsonFailed {
  ok: false;
  error: string;
}

/** Runs one read-only `orca <...> --json` subcommand and parses its output. */
function runOrcaJson(binary: string, args: string[]): OrcaJsonOk | OrcaJsonFailed {
  const result = spawnSync(binary, args, { encoding: "utf-8" });

  if (result.error) {
    return { ok: false, error: result.error.message };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    if (result.status !== 0) {
      return { ok: false, error: result.stderr.trim() || `exited with code ${result.status}` };
    }
    return { ok: false, error: `could not parse JSON output: ${(err as Error).message}` };
  }

  const record = asRecord(parsed);
  if (record && record["ok"] === false) {
    const errRecord = asRecord(record["error"]);
    const message = pickString(errRecord, ["message"]) ?? "unknown error";
    return { ok: false, error: message };
  }

  if (result.status !== 0) {
    return { ok: false, error: result.stderr.trim() || `exited with code ${result.status}` };
  }

  return { ok: true, data: parsed };
}

function extractWorktrees(data: unknown): OrcaWorktreeRow[] {
  const root = asRecord(data);
  const resultValue = root?.["result"];
  const resultRecord = asRecord(resultValue);
  const arr =
    firstArray(
      resultRecord?.["worktrees"],
      resultValue,
      root?.["worktrees"],
      data
    ) ?? [];

  return arr.map((item) => {
    const rec = asRecord(item) ?? {};
    return {
      name: pickString(rec, ["displayName", "name", "id"]) ?? "(unknown)",
      status: pickString(rec, ["workspaceStatus", "status", "state"]) ?? "(unknown)",
      worktreeId: pickString(rec, ["id", "worktreeId"]),
      raw: rec,
    };
  });
}

function extractTerminals(data: unknown): OrcaTerminalRow[] {
  const root = asRecord(data);
  const resultValue = root?.["result"];
  const resultRecord = asRecord(resultValue);
  const arr =
    firstArray(
      resultRecord?.["terminals"],
      resultValue,
      root?.["terminals"],
      data
    ) ?? [];

  return arr.map((item) => {
    const rec = asRecord(item) ?? {};
    return {
      handle: pickString(rec, ["handle", "id"]),
      title: pickString(rec, ["title", "name"]),
      worktreeId: pickString(rec, ["worktreeId", "worktree"]),
      agentGuess: pickString(rec, ["agent", "command"]),
      raw: rec,
    };
  });
}

/**
 * Best-effort `--repo <name>` filter: keeps a worktree row only if the known
 * repo's name or its expanded `worktreeRoot` path shows up somewhere in the
 * row's displayed name/id or any raw string field. Since Orca's exact
 * `worktree ps --json` field names haven't been observed on a live instance
 * while this was written, this deliberately looks broadly rather than
 * assuming one exact field — see the module-level note above.
 */
export function matchesRepoFilter(worktree: OrcaWorktreeRow, repoName: string, worktreeRoot: string): boolean {
  const needles = [repoName.toLowerCase(), worktreeRoot.toLowerCase()];
  const haystacks: string[] = [worktree.name.toLowerCase()];
  if (worktree.worktreeId) haystacks.push(worktree.worktreeId.toLowerCase());
  for (const value of Object.values(worktree.raw)) {
    if (typeof value === "string") haystacks.push(value.toLowerCase());
  }
  return needles.some((needle) => haystacks.some((haystack) => haystack.includes(needle)));
}

/**
 * Best-effort match of a terminal row to a worktree row, purely by comparing
 * whatever id-like fields both sides happen to have. Returns undefined
 * (rendered as "(none)") rather than guessing when nothing lines up.
 */
export function findAgentForWorktree(worktree: OrcaWorktreeRow, terminals: OrcaTerminalRow[]): string | undefined {
  const match = terminals.find(
    (terminal) => terminal.worktreeId !== undefined && worktree.worktreeId !== undefined && terminal.worktreeId === worktree.worktreeId
  );
  return match?.agentGuess ?? match?.title;
}

/**
 * One read-only poll: liveness check first (identical to `doctor`'s check,
 * via the same `checkOrcaLiveness()`), then, only if the app is reachable and
 * running, the two introspection commands. Never calls anything that
 * creates/modifies/spawns a worktree or agent.
 */
export function fetchOrcaSnapshot(binary: string = resolveOrcaBinary()): OrcaSnapshot | OrcaSnapshotFailure {
  const liveness = checkOrcaLiveness(binary);
  if (!liveness.ok) {
    return {
      ok: false,
      reason: `orca status --json did not respond cleanly: ${liveness.error ?? "unknown error"}`,
    };
  }
  if (liveness.running === false) {
    return {
      ok: false,
      reason: "orca status --json reports app running: false — start the Orca app to see live worktrees/agents",
    };
  }

  const worktreePs = runOrcaJson(binary, ["worktree", "ps", "--json"]);
  if (!worktreePs.ok) {
    return { ok: false, reason: `orca worktree ps --json failed: ${worktreePs.error}` };
  }

  const terminalList = runOrcaJson(binary, ["terminal", "list", "--json"]);
  if (!terminalList.ok) {
    return { ok: false, reason: `orca terminal list --json failed: ${terminalList.error}` };
  }

  return {
    ok: true,
    worktrees: extractWorktrees(worktreePs.data),
    terminals: extractTerminals(terminalList.data),
  };
}
