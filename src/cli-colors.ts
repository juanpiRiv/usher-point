/**
 * Minimal ANSI color helpers — deliberately no dependency (chalk/picocolors/
 * kleur/etc are not added; see CONTRIBUTING.md's "no unnecessary
 * abstractions"). Every helper here checks `colorEnabled()` itself, so
 * calling one always returns *some* usable string:
 *   - a non-TTY stdout (piped output — exactly what this project's own REPL
 *     smoke tests in docs/USAGE.md/CONTRIBUTING.md use) skips styling.
 *   - `NO_COLOR` set (see https://no-color.org) skips styling, regardless of
 *     TTY-ness.
 *   - otherwise, plain ANSI SGR codes, reset immediately after the text so
 *     styling never bleeds into whatever's printed next.
 * Checked live on every call (not cached at import time) so tests can set
 * `NO_COLOR` per-invocation.
 */

function colorEnabled(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

function wrap(code: string, text: string): string {
  return colorEnabled() ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const bold = (text: string): string => wrap("1", text);
export const dim = (text: string): string => wrap("2", text);
export const cyan = (text: string): string => wrap("36", text);
export const blue = (text: string): string => wrap("34", text);
export const yellow = (text: string): string => wrap("33", text);
