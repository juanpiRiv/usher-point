import type { TargetConfig } from "../config/schema";
import type { CommandSpec } from "../exec/run-command";

/**
 * Builds:
 *   codex exec --skip-git-repo-check --sandbox <mode> \
 *     --config model_reasoning_effort="<effort>" -C <cwd> "<prompt>"
 *
 * Documented gotcha: non-interactive `codex exec` hangs forever waiting on
 * stdin if it isn't explicitly redirected from /dev/null — the failure is
 * silent (no error, no output), so this is enforced structurally via
 * CommandSpec.stdin = "ignore" rather than left to caller discipline.
 */

const DEFAULT_SANDBOX = "read-only";

export function buildCodexCommand(
  target: TargetConfig,
  taskText: string,
  cwd: string,
  sandbox: string | undefined
): CommandSpec {
  const args: string[] = ["exec", "--skip-git-repo-check", "--sandbox", sandbox ?? DEFAULT_SANDBOX];

  if (target.defaultModel) {
    args.push("--config", `model="${target.defaultModel}"`);
  }
  if (target.defaultEffort) {
    args.push("--config", `model_reasoning_effort="${target.defaultEffort}"`);
  }

  args.push("-C", cwd, taskText);

  return {
    command: target.command,
    args,
    cwd,
    stdin: "ignore",
  };
}
