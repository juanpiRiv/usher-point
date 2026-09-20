import type { TargetConfig } from "../config/schema";
import type { CommandSpec } from "../exec/run-command";
import type { SkillMatch } from "../skills/select";

/**
 * Builds `claude -p "<prompt>" [--allowedTools "<skills>"] [--add-dir <cwd>]`.
 * No sandbox of its own — relies on Claude Code's own permission system.
 */
export function buildClaudeCommand(
  target: TargetConfig,
  taskText: string,
  cwd: string,
  skills: SkillMatch[]
): CommandSpec {
  const args: string[] = [...(target.defaultFlags ?? []), taskText];

  if (skills.length > 0) {
    args.push("--allowedTools", skills.map((skill) => skill.name).join(","));
  }

  args.push("--add-dir", cwd);

  return {
    command: target.command,
    args,
    cwd,
    stdin: "inherit",
  };
}
