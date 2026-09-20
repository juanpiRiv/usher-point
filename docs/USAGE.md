# Usage

The primary way to use `usher-point` is the interactive REPL — run `usher`
(or `usher-point`) with no arguments. For scripts and CI, the three
subcommands remain available: `route` (dry-run), `run` (dry-run + actually
launch), and `doctor` (safe, read-only environment check). All output below
is real, captured from this machine after the `jev` → `usher-point` rename.

## Interactive mode: `usher` / `usher-point` (no arguments)

Bare invocation — no subcommand, no args — starts an interactive loop
instead of printing help, the same pattern as `claude` with no args opening
a chat session. It's read one line at a time via Node's built-in `readline`;
each non-empty line is routed through the exact same `resolveRoute()`
resolution and `printPlan()` formatting that `route` uses (no second
implementation), followed by a `Run this? [y/N]` confirmation that, on
`y`/`yes`, executes the resolved command through the same `exec/run-command.ts`
path that `run` uses.

```
$ usher
usher-point v0.1.0 — interactive mode.
Type a task description, or "exit"/"quit"/Ctrl+D to leave.

usher> fix a typo in README
task:   "fix a typo in README"
rule:   quick-inline
via:    heuristic-fallback (jev-model unavailable)
target: claude-inline
skills: migrating-dbt-project-across-platforms (score 1, fallback)
command: claude -p "fix a typo in README" --allowedTools migrating-dbt-project-across-platforms --add-dir /Users/juanpablorivero/dev/usher-point
Run this? [y/N] n
usher> exit

Goodbye.
```

Notes:
- `exit`, `quit`, empty input at EOF (Ctrl+D), and Ctrl+C all leave cleanly
  with exit code `0` — no crash, no stack trace.
- An empty line (just pressing Enter) is ignored and returns to the prompt;
  it does not exit the loop.
- `--repo`, `--target`, and `--engine` can be typed inline after the task
  text on the same line (e.g. `usher> implement X --target codex-cli`) — a
  minimal, purpose-built split for just these three flags (`parseReplLine` in
  `src/cli.ts`), not a second copy of commander's parser, since a REPL line
  has no shell quoting to reproduce.
- Answering anything other than `y`/`yes` (including a blank line) to `Run
  this? [y/N]` returns to the `usher> ` prompt without executing anything.

### Smoke-testing the REPL (no test suite exists yet)

Since a REPL can't be verified by just running it and waiting, pipe stdin
and check the output plus exit code:

```sh
printf 'fix a typo in README\nn\nexit\n' | usher
echo "exit code: $?"   # expect 0, and the routing decision printed before the "n" prompt

printf 'implement a new multi-file feature across the my-data-warehouse repo\nn\n' | usher
echo "exit code: $?"   # expect 0 — EOF (no explicit "exit") must still end the loop cleanly, not hang
```

Always answer `n` (or let EOF end the session before answering) when testing
this way — the REPL's `Run this? [y/N]` step, on `y`, launches a real
`claude`/`codex`/`orca` subprocess exactly like `usher-point run` does.

## `usher-point route`

Dry-run only — prints the routing decision, the resolved command, and
matched skills. Never spawns a process.

### Quick, single-file task → `claude-inline`

```
$ usher-point route "fix a typo in README"
task:   "fix a typo in README"
rule:   quick-inline
target: claude-inline
skills: gh-fix-ci (score 1, registry), judgment-day (score 1, registry), migrating-dbt-project-across-platforms (score 1, registry)
command: claude -p "fix a typo in README" --allowedTools gh-fix-ci,judgment-day,migrating-dbt-project-across-platforms --add-dir /Users/juanpablorivero
```

### Multi-file task across a known repo → `orca-worktree`

```
$ usher-point route "implement a new multi-file feature across the my-data-warehouse repo"
task:   "implement a new multi-file feature across the my-data-warehouse repo"
rule:   isolated-worktree-build
target: orca-worktree
repo:   my-data-warehouse
worktree root: /Users/juanpablorivero/orca/workspaces/my-data-warehouse
agent:  codex
skills: use-railway (score 2, registry), aplos-gaia-audit (score 1, registry), bigquery-observability (score 1, registry), data-clawlers (score 1, registry), gh-fix-ci (score 1, registry)
command: <unavailable> — usher-point: no Orca CLI reference cache found at /Users/juanpablorivero/dev/usher-point/orca-cli-reference.json. Run `usher-point doctor` first.
```

Before `doctor` has ever run, the cache doesn't exist yet, so `command:`
reports it's unavailable rather than guessing at Orca's syntax (see
"Orca and `doctor`" below for what happens after running it).

### Explicit `--target` overrides the heuristic

```
$ usher-point route "anything" --target codex-cli
task:   "anything"
rule:   explicit-target-flag
target: codex-cli
skills: (none matched)
command: codex exec --skip-git-repo-check --sandbox read-only --config "model=\"gpt-6-astra\"" --config "model_reasoning_effort=\"high\"" -C /Users/juanpablorivero anything
```

### Forcing the heuristic engine explicitly

`--engine heuristic` skips the optional Jev model entirely, even if
`jevModel.enabled` is `true` in config — useful for testing/debugging the
local rules in isolation:

```
$ usher-point route "fix a typo in README" --engine heuristic
task:   "fix a typo in README"
rule:   quick-inline
via:    heuristic (forced)
target: claude-inline
skills: gh-fix-ci (score 1, registry), judgment-day (score 1, registry), migrating-dbt-project-across-platforms (score 1, registry)
command: claude -p "fix a typo in README" --allowedTools gh-fix-ci,judgment-day,migrating-dbt-project-across-platforms --add-dir /Users/juanpablorivero
```

### Default `--engine auto` with no `OPENROUTER_API_KEY` set

This is what every machine without a Jev setup sees by default — `auto`
tries Jev first, and fails closed to the heuristic. Real output, captured on
this machine (no API key configured):

```
$ usher-point route "fix a typo in README"
task:   "fix a typo in README"
rule:   quick-inline
via:    heuristic-fallback (jev-model unavailable)
target: claude-inline
skills: gh-fix-ci (score 1, registry), judgment-day (score 1, registry), migrating-dbt-project-across-platforms (score 1, registry)
command: claude -p "fix a typo in README" --allowedTools gh-fix-ci,judgment-day,migrating-dbt-project-across-platforms --add-dir /Users/juanpablorivero
```

### `--engine jev` (illustrative / untested — no OpenRouter key on this machine)

**This example was not run against the real Jev model** — there is no
OpenRouter API key configured on this machine, so this output is illustrative
of the intended shape only, not a captured run:

```
$ export OPENROUTER_API_KEY=sk-...             # real key, not shown here
$ usher-point route "fix a typo in README" --engine jev
task:   "fix a typo in README"
via:    jev-model (typesafe/jev-1.13)
target: claude-inline
skills: gh-fix-ci (score 1, registry), judgment-day (score 1, registry), migrating-dbt-project-across-platforms (score 1, registry)
command: claude -p "fix a typo in README" --allowedTools gh-fix-ci,judgment-day,migrating-dbt-project-across-platforms --add-dir /Users/juanpablorivero
```

What *was* verified for real on this machine, with `--engine jev` forced and
no API key present, is the fail-closed error path (not a silent fallback):

```
$ usher-point route "anything" --engine jev
usher-point: --engine jev was forced but the Jev model is unavailable (jevModel.enabled is false in usher-point.config.json). Refusing to silently fall back to the heuristic — retry with --engine auto or --engine heuristic.
```

## `usher-point run`

Identical output to `route`, followed by actually launching the resolved
command and streaming its output, exiting with that subprocess's exit code.
Not exercised here beyond `route`/`doctor` (per this repo's own safety
constraints, `run` isn't invoked with anything that would trigger real
agentic work during verification).

## `usher-point doctor`

Safe and read-only by design: checks `claude`/`codex`/`orca` resolve in
`PATH`, does a read-only `orca status --json` liveness check, refreshes
`orca-cli-reference.json` by running `orca skills get orca-cli`, and reports
whether the configured OpenRouter API key env var is set and (only if it is)
whether a live Jev call succeeds. It never spawns a worktree or an agent, and
never prints the key's value.

```
$ usher-point doctor
[ok]   claude -> /Users/juanpablorivero/.local/bin/claude
[ok]   codex -> /opt/homebrew/bin/codex
[ok]   orca -> /usr/local/bin/orca
[ok]   orca status --json reachable (app running: false)
[ok]   refreshed Orca CLI reference cache at /Users/juanpablorivero/dev/usher-point/orca-cli-reference.json
[warn] OPENROUTER_API_KEY not set — Jev routing engine unavailable; usher-point still works via the heuristic engine
```

On this machine, `orca status --json` reached the CLI even with the Orca
desktop app not running (`app running: false`) — `doctor` reports this as
`[ok]` rather than failing, since the liveness check's job is just to
report the app's actual state, not to require it be running. If the `orca`
binary itself weren't on `PATH`, or `orca status --json`/`orca skills get
orca-cli` errored outright, `doctor` reports `[fail]`/`[warn]` per line and
exits non-zero — it does not crash. The `OPENROUTER_API_KEY` line is always
`[warn]` at worst, never `[fail]`, since Jev is optional and the heuristic
engine remains fully functional without it. If the key *is* set, `doctor`
also attempts one live, trivial-prompt Jev call and reports `[ok]`/`[warn]`
for that too — this was not exercised on this machine since no key is
configured here.

### Orca-worktree routing after `doctor`

Re-running the `orca-worktree` verification case after `doctor` still
reports `command: <unavailable>`, but with a different, more specific
reason:

```
$ usher-point route "implement a new multi-file feature across the my-data-warehouse repo"
...
command: <unavailable> — usher-point: Orca CLI reference cache at /Users/juanpablorivero/dev/usher-point/orca-cli-reference.json has no recognized worktree-spawn subcommand. Run `usher-point doctor` to refresh it, or inspect the cache file manually.
```

The cache now exists and was refreshed successfully, but
`orca-adapter.ts`'s extraction heuristic couldn't find a confident
`orca <subcommand> ...` line in the cached `orca-cli` skill text on this
machine (that reference document uses an uppercase `ORCA` placeholder
convention, not a literal lowercase `orca` command line — see
`docs/ARCHITECTURE.md` for the full discrepancy note). This is the intended
fail-closed behavior, not a crash: `usher-point` still refuses to guess at
Orca's subcommand syntax.
