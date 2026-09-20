# usher-point

`usher-point` is a small, on-demand CLI that decides **where** a task should
run — inline in Claude Code, via Codex CLI in a sandbox, or in an isolated
Orca worktree — and, optionally, which skills and model to use for it. It
then dispatches the task there. It is never a daemon: every invocation is a
one-shot decision, and it can also just print the decision without running
anything (`route`).

**`usher-point` does not do the agent's actual work itself.** It classifies
the task text (plus any flags) into a `TaskShape`, decides a target, and
hands off to `claude`, `codex`, or `orca` to do the real work.

> Previously named `jev` during early scaffolding. `usher-point` (this CLI)
> and **Jev** (an unrelated, real, third-party AI model it can *optionally*
> call — see [How it decides](#how-it-decides)) share a name by coincidence
> only.

## Quick start

1. Install it — see [Installation](#installation).
2. Run `usher` bare for an interactive prompt:

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

3. Or, for scripts/CI, use the one-shot `route` subcommand (dry-run, never
   spawns a process):

   ```
   $ usher-point route "fix a typo in README"
   task:   "fix a typo in README"
   rule:   quick-inline
   target: claude-inline
   skills: gh-fix-ci (score 1, registry), judgment-day (score 1, registry), migrating-dbt-project-across-platforms (score 1, registry)
   command: claude -p "fix a typo in README" --allowedTools gh-fix-ci,judgment-day,migrating-dbt-project-across-platforms --add-dir /Users/juanpablorivero
   ```

Both examples are real, captured output — see [docs/USAGE.md](docs/USAGE.md)
for the full set (multi-file/multi-repo routing, `--engine` variants,
`doctor` output, REPL smoke tests).

## How it decides

Two decision engines, picked with `--engine` (an explicit `--target` flag
always wins outright, before either one runs):

- **Heuristic (default)** — `classify.ts` turns the task text + flags into a
  `TaskShape`; `decide.ts` walks the ordered, first-match-wins `rules` in
  [`usher-point.config.json`](usher-point.config.json); an unmatched task
  falls back to `claude-inline`. No network calls, no ML — every signal is
  an inspectable keyword/flag check (`usher-point route --verbose` prints
  the full `TaskShape` and which rule matched).
- **Jev (`--engine jev`)** — optionally calls TypeSafe AI's "Jev" model via
  OpenRouter, which returns **target + relevant skills + an optional
  model/effort override in one call**. `--engine auto` (default) tries Jev
  first and fails closed to the heuristic on any problem (disabled, no key,
  network error, bad reply); `--engine jev` fails loudly instead of silently
  falling back, since you asked for it explicitly.

Full flow diagrams and module responsibilities:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Installation

There are two supported ways to get `usher-point`, depending on what you're
doing.

### Development

Working *on* `usher-point` itself:

```sh
git clone https://github.com/juanpiRiv/usher-point.git
cd usher-point
npm install
npm run build
npm link
```

`npm link` makes `usher`/`usher-point` resolve globally to this checkout's
`dist/cli.js`. While editing, run `npm run dev` (a `tsc --watch`) in a spare
terminal to rebuild on save — no need to re-link. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full dev workflow, engineering
conventions, and how to add rules/adapters.

### Install as a CLI (no cloning)

Using `usher-point` on a machine without cloning or building it yourself:

```sh
npm install -g github:juanpiRiv/usher-point
usher
```

This installs directly from the public GitHub repo — no npm registry
publish is involved. TypeScript is built automatically on install via the
package's `prepare` script; there is nothing else to run.

**Requires npm ≥ 12.** Older npm (confirmed broken on 11.19.0) doesn't
install `devDependencies` before running `prepare` for a global git
install, so the build silently never runs and no `usher`/`usher-point`
binary gets created — with no error shown. Check with `npm -v`; if you're
below 12, run `npm install -g npm@latest` first, or use
`npx -y npm@latest install -g github:juanpiRiv/usher-point` instead.

`usher-point` only *orchestrates* other CLIs — it doesn't install them. For
it to be useful, also make sure these are on your `PATH`:

- `claude` (Claude Code) and `codex` (Codex CLI) — required, since every
  routing target ultimately shells out to one of these.
- `orca` — optional, only needed if you use the `orca-worktree` target.

`OPENROUTER_API_KEY` is optional and only needed if you enable the Jev
routing engine (see [How it decides](#how-it-decides)). Instead of exporting
it in every shell session, you can store it once with
`usher-point config set-key <value>` — see [Configuration](#configuration).

## Commands

| Command | What it does |
|---|---|
| `usher` (bare, no args) | Interactive REPL — type a task, review the decision, confirm `[y/N]` to run it |
| `usher-point route "<task>" [flags]` | Dry-run: prints the decision and the resolved command, never spawns a process |
| `usher-point run "<task>" [flags]` | Same as `route`, then actually launches the resolved command and streams its output |
| `usher-point doctor` | Safe, read-only PATH/liveness check; refreshes the Orca CLI reference cache; reports Jev availability |
| `usher-point config set-key <value>` / `set-key` (stdin) | Store the Jev/OpenRouter API key locally, mode `600`; never printed |
| `usher-point config unset-key` | Remove the locally stored key |
| `usher-point config status` | Report whether a key is configured and its source, never the value |

`usher` and `usher-point` are the same binary — both point at the same
`dist/cli.js`. Full flags (`--repo`, `--target`, `--engine`, `--verbose`)
and captured examples for every command: [docs/USAGE.md](docs/USAGE.md).

## Configuration

All routing behavior lives in
[`usher-point.config.json`](usher-point.config.json): `targets` (base
command + defaults per target), `rules` (ordered, first-match-wins),
`knownRepos` (repo name → Orca worktree root), and `jevModel`
(enable/model/API key env var name). It's hand-edited and read fresh on
every invocation — no rebuild needed. See
[CONTRIBUTING.md](CONTRIBUTING.md#adding-a-new-routing-rule) for how to add
a rule, and [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-new-adapter) for how
to add a new target adapter.

### The Jev/OpenRouter API key

`usher-point.config.json` only names *which* environment variable to read
the key from (`jevModel.apiKeyEnvVar`, default `OPENROUTER_API_KEY`) — it
never stores the key itself, since that file is versioned and committed.
Two ways to actually provide the key, checked in this order:

1. **The environment variable itself** (e.g. `export OPENROUTER_API_KEY=...`)
   — always wins if set, for an explicit per-session override.
2. **A local, persistent file**: `~/.config/usher-point/config.json`
   (outside the repo, never committed, mode `600`), managed with:

   ```sh
   usher-point config set-key <value>   # store it locally
   usher-point config unset-key         # remove it
   usher-point config status            # report presence + source only
   ```

If neither is set, the Jev engine is unavailable and `usher-point` fails
closed to the heuristic engine, exactly as before this existed. Full detail,
including the stdin-piping alternative to a plain CLI argument: see
[docs/USAGE.md](docs/USAGE.md#usher-point-config).

## Status: what's actually verified

This project is young and honest about it:

- **`usher-point run` (real execution)** — dry-run-verified (`route`'s
  output has been checked against expectations for all three targets) but
  **not** exhaustively battle-tested actually launching every real target
  end-to-end.
- **The Jev/OpenRouter engine** — implemented and unit-verified with a
  mocked OpenRouter response, including its fail-closed-to-heuristic path,
  but **never exercised with a real API key on this machine** — there is no
  `OPENROUTER_API_KEY` configured here. `--engine jev`'s "unavailable" error
  path *has* been verified for real (see docs/USAGE.md).
- **The Orca-worktree path** — depends on a cached CLI reference
  (`orca-cli-reference.json`) that `usher-point doctor` refreshes; if
  Orca's own CLI syntax has drifted since that cache was captured, routing
  to `orca-worktree` fails closed with a "run `usher-point doctor`" error
  rather than guessing. On this machine, the currently-cached reference
  doesn't expose a syntax `orca-adapter.ts` can confidently extract, so
  `orca-worktree` isn't reachable end-to-end here right now — see
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#the-orca-worktree-path-most-fragile-boundary)
  for the exact discrepancy.

This matches the project's own design philosophy: fail closed, be explicit,
never guess.

## License & contributing

Contributions, dev workflow, and engineering conventions:
[CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
