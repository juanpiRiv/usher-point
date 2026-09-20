# CLAUDE.md

Instructions for Claude Code when working in this repository.

## What this project is

`usher-point` is a small, on-demand local CLI (never a daemon) that decides
*where* a given task should run — inline in Claude Code, via Codex CLI with a
sandbox, or in an isolated Orca worktree — and, optionally, dispatches it
there. It never performs the agent's actual work itself: it classifies the
task text and flags into a `TaskShape`, walks an ordered, first-match-wins
rule list in `usher-point.config.json`, and either prints the resulting
decision (`usher-point route`) or launches the resolved subprocess
(`usher-point run`). It was previously named `jev` during scaffolding; the
rename to `usher-point` is complete across the package name, bin, and config
filename. Separately, `usher-point` can *optionally* call a real third-party
model also named **Jev** (TypeSafe AI's "Jev", via OpenRouter — see
`src/routing/jev-model.ts`) to make the routing decision instead of the local
heuristic. These are two unrelated things that happen to share a name:
`usher-point` is this CLI; `Jev` is the optional external decision model it
can call.

## Module layout

Three modules, each with one responsibility (screaming architecture — see
`docs/ARCHITECTURE.md` for the full diagram):

- **`src/routing/`** — decides *where*. `classify.ts` turns task text + CLI
  flags into a `TaskShape` (keyword/flag checks only, no ML). `decide.ts`
  walks `usher-point.config.json`'s `rules` in order and returns a
  `Decision` (first match wins; an explicit `--target` flag always wins
  outright; unmatched tasks fall back to `claude-inline`). `jev-model.ts` is
  an alternative decision source in the same module (not `adapters/`,
  because it never spawns a process — it makes one HTTP call to OpenRouter to
  *decide*, then hands off to the same adapters). It fails closed to `null`
  on any problem (disabled, no key, network error, bad reply) so `cli.ts` can
  always fall back to the heuristic; see `--engine` in `docs/USAGE.md`.
- **`src/skills/`** — decides *what* skills/tools are relevant. Reads
  `<cwd>/.atl/skill-registry.md` when present, otherwise falls back to
  scanning `~/.agents/skills/*/SKILL.md` frontmatter. Always returns paths
  to `SKILL.md`, never injected content.
- **`src/adapters/` + `src/exec/`** — the boundary to external processes.
  Each adapter (`claude-adapter.ts`, `codex-adapter.ts`, `orca-adapter.ts`)
  only *describes* a `CommandSpec`; `exec/run-command.ts` is the single place
  that actually spawns a child process.

## Build / test / verify

- `npm run build` — `tsc -p tsconfig.json` then a small shebang-injection
  script for `dist/cli.js`. No test suite exists yet.
- After building and `npm link`, the three verification commands are:
  - `usher-point route "fix a typo in README"` → expect target `claude-inline`
  - `usher-point route "implement a new multi-file feature across the my-data-warehouse repo"` → expect target `orca-worktree`
  - `usher-point route "anything" --target codex-cli` → expect the explicit `--target` flag to win
- `usher-point doctor` is safe and read-only by design: it checks
  `claude`/`codex`/`orca` resolve in `PATH`, does a read-only
  `orca status --json` liveness check, refreshes the gitignored
  `orca-cli-reference.json` cache via `orca skills get orca-cli`, and reports
  whether `OPENROUTER_API_KEY` (or whatever `jevModel.apiKeyEnvVar` is
  configured to) is set and whether a live Jev call succeeds — never printing
  the key itself. It never spawns a worktree or an agent.

## Hard rule: never hardcode or print the OpenRouter API key

`usher-point` never stores an API key literal anywhere in code, config, or
docs. `usher-point.config.json`'s `jevModel.apiKeyEnvVar` only names *which*
environment variable to read (default `OPENROUTER_API_KEY`); the key itself
is read from `process.env` at call time in `src/routing/jev-model.ts` and
never logged, printed, or included in an error message. `usher-point doctor`
reports only whether the variable is set, never its value.

## Hard rule: never hardcode Orca CLI subcommand syntax

Orca's own CLI subcommand syntax changes between Orca releases. `usher-point`
never hardcodes it. The real worktree-spawn command is only ever resolved
from the cached reference at `orca-cli-reference.json`, which
`usher-point doctor` refreshes by running `orca skills get orca-cli`. If that
cache is missing, or `orca-adapter.ts`'s conservative extraction heuristic
can't find a confident `orca ... worktree|spawn ...` line in the cached
reference text, `usher-point` fails closed with a "run `usher-point doctor`"
error rather than guessing at syntax. When working on `orca-adapter.ts`,
preserve this fail-closed behavior — do not add a fallback hardcoded
invocation.
