# AGENTS.md

This mirrors `CLAUDE.md` (written for Claude Code specifically) in the
generic cross-tool `AGENTS.md` convention read by Codex CLI and other
coding agents. Facts are kept in sync between the two files; see
`CLAUDE.md` for the same content in Claude-Code-flavored form.

## Project

`usher-point` is a small, on-demand local CLI (never a daemon) that decides
*where* a task should run — Claude Code inline, Codex CLI with a sandbox, or
an isolated Orca worktree — and optionally dispatches it. It classifies task
text/flags into a `TaskShape`, walks first-match-wins rules in
`usher-point.config.json`, and either prints the decision (`usher-point
route`) or launches the resolved subprocess (`usher-point run`). Formerly
named `jev`.

## Layout

- `src/routing/` — `classify.ts` (task text/flags → `TaskShape`) and
  `decide.ts` (`TaskShape` + config rules → `Decision`, first match wins).
- `src/skills/` — selects relevant `SKILL.md` paths via
  `.atl/skill-registry.md` when present, else a fallback scan of
  `~/.agents/skills/`.
- `src/adapters/` + `src/exec/` — one adapter per target
  (`claude-adapter.ts`, `codex-adapter.ts`, `orca-adapter.ts`) builds a
  `CommandSpec`; `exec/run-command.ts` is the only place a subprocess is
  actually spawned.

## Commands

- Build: `npm run build`
- Verify routing:
  - `usher-point route "fix a typo in README"` → `claude-inline`
  - `usher-point route "implement a new multi-file feature across the my-data-warehouse repo"` → `orca-worktree`
  - `usher-point route "anything" --target codex-cli` → explicit target wins
- `usher-point doctor` — safe, read-only PATH/liveness check + Orca reference
  cache refresh. Never spawns a worktree or agent.

## Hard constraint

Never hardcode Orca's CLI subcommand syntax anywhere in this codebase — it
changes between Orca releases. Always resolve the real worktree-spawn
command from the cached reference (`orca-cli-reference.json`) that
`usher-point doctor` produces by running `orca skills get orca-cli`. If the
cache is missing or unparseable, fail closed with a message pointing at
`usher-point doctor` — never fall back to a guessed invocation.
