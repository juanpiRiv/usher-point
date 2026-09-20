import { spawn } from "node:child_process";

/**
 * The single place in jev that actually launches a child process. Every
 * adapter only *describes* a command (CommandSpec); this module is the only
 * place that spawns it, so process-safety fixes (like the Codex stdin gotcha)
 * live in exactly one spot.
 */

export interface CommandSpec {
  command: string;
  args: string[];
  cwd?: string;
  /**
   * "ignore" is required for non-interactive subprocesses like `codex exec`
   * — without it, Codex hangs waiting on stdin with no visible error when
   * launched from a non-TTY context. "inherit" is fine for tools that expect
   * a live terminal (none of jev's current adapters need it, but it's kept
   * explicit rather than defaulted away).
   */
  stdin: "ignore" | "inherit";
}

export function formatCommand(spec: CommandSpec): string {
  const parts = [spec.command, ...spec.args.map(quoteIfNeeded)];
  return parts.join(" ");
}

function quoteIfNeeded(arg: string): string {
  if (arg === "") return '""';
  return /[\s"'$`\\]/.test(arg) ? `"${arg.replace(/(["\\$`])/g, "\\$1")}"` : arg;
}

export function runCommand(spec: CommandSpec): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      stdio: [spec.stdin, "inherit", "inherit"],
    });

    child.on("error", (err) => {
      reject(new Error(`jev: failed to launch "${spec.command}": ${err.message}`));
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`jev: "${spec.command}" was terminated by signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}
