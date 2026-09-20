# Usage

Three commands: `route` (dry-run), `run` (dry-run + actually launch), and
`doctor` (safe, read-only environment check). All output below is real,
captured from this machine after the `jev` → `usher-point` rename.

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
$ usher-point route "implement a new multi-file feature across the takenos-data-stack repo"
task:   "implement a new multi-file feature across the takenos-data-stack repo"
rule:   isolated-worktree-build
target: orca-worktree
repo:   takenos-data-stack
worktree root: /Users/juanpablorivero/orca/workspaces/takenos-data-stack
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

## `usher-point run`

Identical output to `route`, followed by actually launching the resolved
command and streaming its output, exiting with that subprocess's exit code.
Not exercised here beyond `route`/`doctor` (per this repo's own safety
constraints, `run` isn't invoked with anything that would trigger real
agentic work during verification).

## `usher-point doctor`

Safe and read-only by design: checks `claude`/`codex`/`orca` resolve in
`PATH`, does a read-only `orca status --json` liveness check, and refreshes
`orca-cli-reference.json` by running `orca skills get orca-cli`. It never
spawns a worktree or an agent.

```
$ usher-point doctor
[ok]   claude -> /Users/juanpablorivero/.local/bin/claude
[ok]   codex -> /opt/homebrew/bin/codex
[ok]   orca -> /usr/local/bin/orca
[ok]   orca status --json reachable (app running: false)
[ok]   refreshed Orca CLI reference cache at /Users/juanpablorivero/dev/usher-point/orca-cli-reference.json
```

On this machine, `orca status --json` reached the CLI even with the Orca
desktop app not running (`app running: false`) — `doctor` reports this as
`[ok]` rather than failing, since the liveness check's job is just to
report the app's actual state, not to require it be running. If the `orca`
binary itself weren't on `PATH`, or `orca status --json`/`orca skills get
orca-cli` errored outright, `doctor` reports `[fail]`/`[warn]` per line and
exits non-zero — it does not crash.

### Orca-worktree routing after `doctor`

Re-running the `orca-worktree` verification case after `doctor` still
reports `command: <unavailable>`, but with a different, more specific
reason:

```
$ usher-point route "implement a new multi-file feature across the takenos-data-stack repo"
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
