# jev

`jev` is a small, on-demand local CLI that decides *where* a task should run —
Claude Code inline, Codex CLI (with a sandbox), or an isolated Orca worktree —
and, optionally, dispatches it there. It is never a daemon; every invocation
is a one-shot decision.

`jev` never does the agent's work itself. It classifies the task text (plus
any flags) into a `TaskShape`, walks the rules in `jev.config.json` in order
(first match wins), and either prints the decision (`jev route`) or actually
launches the resolved command (`jev run`).

## Commands

### `jev route "<task>" [--repo <name>] [--target <target>] [--worktree] [--verbose]`

Dry-run (the default way to use jev). Prints:
- which rule matched (or `explicit-target-flag` / `fallback-claude-inline`)
- the resolved target (`claude-inline`, `codex-cli`, or `orca-worktree`)
- the exact command that would run
- which skills (paths to `SKILL.md`, never their content) look relevant

Never spawns a process.

### `jev run "<task>" [same flags]`

Does everything `route` does, then actually launches `claude`, `codex`, or
`orca` as a subprocess and streams its output. Exits with that subprocess's
exit code.

### `jev doctor`

Checks that `claude`, `codex`, and `orca` resolve in `PATH`, does a read-only
`orca status --json` liveness check, and refreshes the local
`orca-cli-reference.json` cache (gitignored) by running `orca skills get
orca-cli`. `jev` never hardcodes Orca's own subcommand syntax — it changes
between Orca releases — so the real worktree-spawn command is only ever read
from this cache. If the cache is missing or stale, run `jev doctor` again.

## Editing `jev.config.json`

This file is the entire ruleset and is meant to be hand-edited:

- **`targets`** — the base command + defaults for each of the three targets
  (`claudeInline`, `codexCli`, `orcaWorktree`).
- **`rules`** — an ordered list. Each rule has a `when` clause (`multiFile`,
  `multiRepo`, `needsIsolation` — omit a field to make it a wildcard) and a
  `target`. The first rule whose `when` clause matches the task wins. If
  nothing matches, jev falls back to `claudeInline` (the cheapest/safest
  option). An explicit `--target` flag on the CLI always wins outright,
  before any rule is consulted.
- **`knownRepos`** — maps a repo name to its Orca worktree root
  (`~` is expanded to your home directory). Mentioning a known repo's name in
  the task text, or passing `--repo <name>`, marks the task as multi-repo and
  triggers isolation.

To add a new rule or repo, just add an entry and re-run `jev route` — no
rebuild needed, since `jev.config.json` is read (and zod-validated) fresh on
every invocation from the package root.
