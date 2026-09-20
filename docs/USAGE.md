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
of the intended shape only, not a captured run. Since this change, the Jev
call is a **unified decision**: one OpenRouter call returns `target` *and*
`skills` *and* an optional `modelOverride`, replacing `skills/select.ts`'s
keyword-overlap ranking for that call (`skills/select.ts` still gathers the
raw candidate list Jev is shown — it just doesn't rank it on this path). The
`skills:` line below has no `score` because Jev doesn't produce a numeric
score, only a relevance judgment; a `model override:` line only appears when
Jev actually returned one:

```
$ export OPENROUTER_API_KEY=sk-...             # real key, not shown here
$ usher-point route "fix a typo in README" --engine jev
task:   "fix a typo in README"
via:    jev-model (typesafe/jev-1.13)
target: claude-inline
skills: gh-fix-ci (jev-model), migrating-dbt-project-across-platforms (jev-model)
command: claude -p "fix a typo in README" --allowedTools gh-fix-ci,migrating-dbt-project-across-platforms --add-dir /Users/juanpablorivero
```

Illustrative example where Jev also judges the task needs a different
model/effort than the target's configured default:

```
$ usher-point route "refactor generics across five files" --engine jev
task:   "refactor generics across five files"
via:    jev-model (typesafe/jev-1.13)
target: codex-cli
skills: typescript-advanced-types (jev-model)
model override: effort=high
command: codex exec --skip-git-repo-check --sandbox read-only --config "model=\"gpt-6-astra\"" --config "model_reasoning_effort=\"high\"" -C /Users/juanpablorivero refactor generics across five files
```

This module's prompt-building and response-parsing logic (including the
fail-closed-to-`null` path on a malformed reply, and dropping any
Jev-returned skill name/path that doesn't match a shown candidate) was unit
verified with a mocked OpenRouter response — see `src/routing/jev-model.ts`;
no test framework was added for this (none exists yet in this repo, see
`CONTRIBUTING.md`), so it was a throwaway standalone script, not committed.

What *was* verified for real on this machine, with `--engine jev` forced and
no API key present, is the fail-closed error path (not a silent fallback):

```
$ usher-point route "anything" --engine jev
usher-point: --engine jev was forced but the Jev model is unavailable (jevModel.enabled is false in usher-point.config.json). Refusing to silently fall back to the heuristic — retry with --engine auto or --engine heuristic.
```

## `usher-point run`

Identical output to `route`, followed by actually launching the resolved
command and streaming its output, exiting with that subprocess's exit code.

### Real, non-dry-run execution (`claude-inline` target)

Unlike the `route` examples above, this one is a genuine executed run, not a
dry-run — chosen specifically because it routes to `claude-inline`, the
lowest-blast-radius target (no sandboxed write access, no worktree
creation), and the task itself is phrased to be strictly read-only:

```
$ usher-point run "in the current directory, just read package.json and tell me the version field, do not modify anything"
task:   "in the current directory, just read package.json and tell me the version field, do not modify anything"
rule:   quick-inline
via:    heuristic-fallback (jev-model unavailable)
target: claude-inline
skills: upgrading-dbt-core (score 2, fallback), using-dbt-state (score 2, fallback), answering-natural-language-questions-with-dbt (score 1, fallback), configuring-dbt-mcp-server (score 1, fallback), creating-mermaid-dbt-dag (score 1, fallback)
command: claude -p "in the current directory, just read package.json and tell me the version field, do not modify anything" --allowedTools upgrading-dbt-core,using-dbt-state,answering-natural-language-questions-with-dbt,configuring-dbt-mcp-server,creating-mermaid-dbt-dag --add-dir /Users/juanpablorivero/dev/usher-point

> launching: claude -p "in the current directory, just read package.json and tell me the version field, do not modify anything" --allowedTools upgrading-dbt-core,using-dbt-state,answering-natural-language-questions-with-dbt,configuring-dbt-mcp-server,creating-mermaid-dbt-dag --add-dir /Users/juanpablorivero/dev/usher-point

`"version": "0.1.0"`
```

Verified for this run:
- It actually launched and streamed a real `claude -p` subprocess (the
  `> launching: ...` line plus the answer above it are `exec/run-command.ts`'s
  real stdout, not a plan) and printed a correct, on-topic answer (`0.1.0`
  matches this repo's actual `package.json` at the time of the run).
- `git status` was clean immediately before and after the run (only this
  change's own source edits were present) — no file in the repo was
  created, modified, or deleted by the run itself.
- One incidental, non-repo side effect was observed and is worth recording
  honestly: the invoked `claude` subprocess materialized an untracked
  `.atl/skill-registry.md` (and `.atl/.skill-registry.cache.json`) in the
  working directory, per its own header comment auto-generated by this
  machine's `gentle-ai skill-registry refresh` tooling. This is an artifact
  of the external `claude` CLI's own project skill-registry cache — not
  `usher-point` code (no file under `src/` writes to `.atl/`; only
  `src/skills/registry-reader.ts` *reads* it if present) — and it reappears
  on any `claude -p` invocation in this directory regardless of task or
  flags. It was deleted after the test to leave the tree clean, and does not
  reflect a change made by `usher-point` itself.
- No `usher`/`claude`/`orca`/`codex` process was left running afterward
  (`pgrep -fl usher` returned nothing).

This exercises the same `exec/run-command.ts` spawn path shared by all three
targets, so it validates `run`'s dispatch/exec mechanism itself; a real test
against `codex-cli` or `orca-worktree` was intentionally not performed here
(sandboxed write access / real worktree creation — bigger blast radius, not
needed to validate the shared exec path).

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

### Orca-worktree routing after `doctor` (fixed)

**Update:** the case below described a bug that has since been fixed in
`orca-adapter.ts` — see the updated "Orca-worktree path" note in
`docs/ARCHITECTURE.md`. `extractSpawnCommandTemplate()` now matches the
leading `orca`/`ORCA` token case-insensitively (the cached reference on this
machine documents examples with an uppercase `ORCA` placeholder, not a
literal lowercase `orca`), requires an actual `worktree create` (or `spawn`)
subcommand rather than any line merely containing the word "worktree" (so it
doesn't grab a management command like `worktree ps` first), and tokenizes
quoted example values (`--prompt "<task brief>"`) as one token instead of
splitting on the space inside the quotes. Re-running the same verification
case after `doctor` now resolves a real command instead of failing closed:

```
$ usher-point route "implement a new multi-file feature across the my-data-warehouse repo"
task:   "implement a new multi-file feature across the my-data-warehouse repo"
rule:   isolated-worktree-build
via:    heuristic-fallback (jev-model unavailable)
target: orca-worktree
repo:   my-data-warehouse
worktree root: /Users/juanpablorivero/orca/workspaces/my-data-warehouse
agent:  codex
skills: image-to-code (score 1, fallback), imagegen-frontend-web (score 1, fallback), maintaining-dbt-documentation (score 1, fallback), sql-queries (score 1, fallback)
command: orca worktree create --name <task-name> --no-parent --agent codex --prompt "<task brief>" --json
```

Caveat, not a further bug: `<task-name>` and `"<task brief>"` are the cached
reference doc's own illustrative example values, left as-is. `buildOrcaCommand`
only substitutes its own `{{task}}`/`{{cwd}}`/`{{repo}}`/`{{agent}}` tokens,
none of which appear in this line, so the resolved command is a real,
confidently-parsed invocation shape but still carries the doc's example text
rather than this specific task's values — mapping `<...>`-style doc
placeholders to specific flags would itself be exactly the kind of guess at
Orca's syntax this module is designed to avoid, so it was left alone.

The previous fail-closed behavior below is kept here for history/context —
it's what a version of `orca-adapter.ts` without the fix above produces:

```
$ usher-point route "implement a new multi-file feature across the my-data-warehouse repo"
...
command: <unavailable> — usher-point: Orca CLI reference cache at /Users/juanpablorivero/dev/usher-point/orca-cli-reference.json has no recognized worktree-spawn subcommand. Run `usher-point doctor` to refresh it, or inspect the cache file manually.
```

Before the fix, the cache existed and was refreshed successfully, but
`orca-adapter.ts`'s extraction heuristic couldn't find a confident
`orca <subcommand> ...` line in the cached `orca-cli` skill text on this
machine (that reference document uses an uppercase `ORCA` placeholder
convention, not a literal lowercase `orca` command line — see
`docs/ARCHITECTURE.md` for the full discrepancy note). This is the intended
fail-closed behavior, not a crash: `usher-point` still refuses to guess at
Orca's subcommand syntax.
