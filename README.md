# usher-point

`usher-point` is a small, on-demand local CLI that decides *where* a task should run —
Claude Code inline, Codex CLI (with a sandbox), or an isolated Orca worktree —
and, optionally, dispatches it there. It is never a daemon; every invocation
is a one-shot decision.

`usher-point` never does the agent's work itself. It classifies the task text (plus
any flags) into a `TaskShape`, walks the rules in `usher-point.config.json` in order
(first match wins), and either prints the decision (`usher-point route`) or actually
launches the resolved command (`usher-point run`).

The binary is installed under two names — `usher` (short) and `usher-point`
(the full package name) — both point at the same `dist/cli.js`. Run either
bare, with no arguments, to get an interactive prompt (see below); pass a
subcommand (`route`/`run`/`doctor`) for one-shot/scripted use.

> This project was previously named `jev` during scaffolding. The binary,
> package name, and config filename are now all `usher-point`; a leftover
> `jev.config.json` is still picked up as a fallback for one release if
> `usher-point.config.json` isn't found (see `src/config/load.ts`). To avoid
> confusion: **`usher-point` is this CLI**; **`Jev`** (below) is an unrelated,
> real, third-party AI model this CLI can *optionally* call — the old
> scaffolding name and the third-party model name are just a coincidence.

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
terminal to rebuild on save — no need to re-link. See `CONTRIBUTING.md` for
the full dev workflow, engineering conventions, and how to add rules/adapters.

### Install as a CLI (no cloning)

Using `usher-point` on a machine without cloning or building it yourself:

```sh
npm install -g github:juanpiRiv/usher-point
usher
```

This installs directly from the public GitHub repo — no npm registry
publish is involved. TypeScript is built automatically on install via the
package's `prepare` script; there is nothing else to run.

`usher-point` only *orchestrates* other CLIs — it doesn't install them. For
it to be useful, also make sure these are on your `PATH`:

- `claude` (Claude Code) and `codex` (Codex CLI) — required, since every
  routing target ultimately shells out to one of these.
- `orca` — optional, only needed if you use the `orca-worktree` target.

`OPENROUTER_API_KEY` is optional and only needed if you enable the Jev
routing engine (see below).

## Interactive mode (primary way to use it)

Run `usher` (or `usher-point` — both resolve to the same binary) with no
arguments and it opens an interactive loop, the same pattern as `claude` with
no args opening a chat session:

```
$ usher
usher-point v0.1.0 — interactive mode.
Type a task description, or "exit"/"quit"/Ctrl+D to leave.

usher> fix a typo in README
task:   "fix a typo in README"
rule:   quick-inline
via:    heuristic-fallback (jev-model unavailable)
target: claude-inline
skills: gh-fix-ci (score 1, registry)
command: claude -p "fix a typo in README" --allowedTools gh-fix-ci --add-dir /path/to/repo
Run this? [y/N] n
usher> exit

Goodbye.
```

Type a task description at the `usher> ` prompt, review the routing decision
it prints (identical output to `usher route`), then answer the `Run this?
[y/N]` confirmation — `y`/`yes` actually launches the resolved command and
streams its output; anything else (including empty input) returns you to the
prompt without running it. `exit`, `quit`, Ctrl+D (EOF), or Ctrl+C all leave
cleanly. You can append `--repo`, `--target`, or `--engine` inline after your
task text (e.g. `usher> implement X --target codex-cli`) — the same flags
`route`/`run` accept as separate CLI flags.

## One-shot commands (scripting / explicit use)

For scripts, CI, or explicit one-shot invocations, use the `route`/`run`/
`doctor` subcommands directly — these are unchanged and remain fully
scriptable.

### `usher-point route "<task>" [--repo <name>] [--target <target>] [--worktree] [--verbose] [--engine <heuristic|jev|auto>]`

Dry-run (the default way to use usher-point). Prints:
- which engine decided (`via:`) and, for the heuristic, which rule matched
  (or `explicit-target-flag` / `fallback-claude-inline`)
- the resolved target (`claude-inline`, `codex-cli`, or `orca-worktree`)
- the exact command that would run
- which skills (paths to `SKILL.md`, never their content) look relevant

Never spawns a process.

### `usher-point run "<task>" [same flags]`

Does everything `route` does, then actually launches `claude`, `codex`, or
`orca` as a subprocess and streams its output. Exits with that subprocess's
exit code.

### `usher-point doctor`

Checks that `claude`, `codex`, and `orca` resolve in `PATH`, does a read-only
`orca status --json` liveness check, refreshes the local
`orca-cli-reference.json` cache (gitignored) by running `orca skills get
orca-cli`, and reports whether the Jev routing engine is usable (see below).
`usher-point` never hardcodes Orca's own subcommand syntax — it changes
between Orca releases — so the real worktree-spawn command is only ever read
from this cache. If the cache is missing or stale, run `usher-point doctor`
again.

## Optional: routing via TypeSafe AI's "Jev" model

By default, `usher-point` decides where to route a task with the local,
hand-written heuristic in `src/routing/classify.ts` + `decide.ts`, and which
skills are relevant with `src/skills/select.ts`'s keyword-overlap ranking —
plain keyword/flag checks, no network calls, no ML. Optionally, it can
instead ask **TypeSafe AI's "Jev"** model — a real third-party "System One
Model" purpose-built for fast structured/typed decisions (routing,
classification), not general chat — to make **one unified decision** covering
target, skills, *and* an optional model/effort override, in a single call.
`usher-point` reaches it only through **OpenRouter's** standard
chat-completions API (`https://openrouter.ai/api/v1/chat/completions`), using
your own OpenRouter API key. `usher-point` never talks to
`docs.typesafe.ai`/`console.typesafe.ai` directly and never stores or prints
your API key.

This unification only applies when the Jev engine actually decides: Jev is
shown the same candidate skill list the heuristic path would rank (gathered
by `skills/select.ts`'s `gatherSkillCandidates()`, capped for prompt size by
`capCandidates()` if unusually large) and returns which of them it judges
relevant, replacing the keyword-overlap step for that call. Any Jev failure —
disabled, no key, network error, malformed reply — falls back to the
heuristic **and** `skills/select.ts` together, never a mixed decision. See
`docs/ARCHITECTURE.md` for the full flow and `docs/USAGE.md` for illustrative
(untested — no API key on this machine) example output.

To enable it:

1. Get an OpenRouter API key (see `openrouter.ai/typesafe` for the Jev model
   listing) and export it: `export OPENROUTER_API_KEY=sk-...` (see
   `env.example` for the variable name — named without the usual leading dot
   because this environment's own tool permissions hard-deny writing `.env*`
   files). `usher-point` itself never reads a `.env` file — it only reads
   `process.env` at call time.
2. In `usher-point.config.json`, set `"jevModel": { "enabled": true, ... }`.
   `model` defaults to `"typesafe/jev-1.13"` (pinned) — `"typesafe/jev-latest"`
   is also valid. `apiKeyEnvVar` defaults to `"OPENROUTER_API_KEY"` and can be
   changed if you keep the key under a different variable name.

Behavior:
- **`--engine auto`** (default) — try Jev first; on *any* failure (disabled,
  no key, network error, bad HTTP status, unparseable reply) it fails closed
  to the local heuristic, and `route`/`run` print which engine actually
  decided (e.g. `via: heuristic-fallback (jev-model unavailable)` or
  `via: jev-model (typesafe/jev-1.13)`).
- **`--engine heuristic`** — always use the local rules, never call OpenRouter.
- **`--engine jev`** — always call Jev; if it's unavailable for any reason,
  this fails loudly with a clear error instead of silently substituting the
  heuristic, since you explicitly asked for Jev.

`usher-point` never crashes because Jev is unavailable — the local heuristic
remains the default and the fallback path in `--engine auto`.

## Editing `usher-point.config.json`

This file is the entire ruleset and is meant to be hand-edited:

- **`targets`** — the base command + defaults for each of the three targets
  (`claudeInline`, `codexCli`, `orcaWorktree`).
- **`rules`** — an ordered list. Each rule has a `when` clause (`multiFile`,
  `multiRepo`, `needsIsolation` — omit a field to make it a wildcard) and a
  `target`. The first rule whose `when` clause matches the task wins. If
  nothing matches, usher-point falls back to `claudeInline` (the
  cheapest/safest option). An explicit `--target` flag on the CLI always
  wins outright, before any rule is consulted.
- **`knownRepos`** — maps a repo name to its Orca worktree root
  (`~` is expanded to your home directory). Mentioning a known repo's name in
  the task text, or passing `--repo <name>`, marks the task as multi-repo and
  triggers isolation.

To add a new rule or repo, just add an entry and re-run `usher-point route` —
no rebuild needed, since `usher-point.config.json` is read (and zod-validated)
fresh on every invocation from the package root.

See `docs/ARCHITECTURE.md` for the module layout and `docs/USAGE.md` for
real example invocations.
