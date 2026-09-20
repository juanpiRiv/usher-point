# Contributing

## Local setup

```sh
git clone <repo-url> usher-point
cd usher-point
npm install
npm run build
npm link
```

`npm link` installs two binaries globally — `usher` (short) and
`usher-point` (full) — both resolving via `npm config get prefix` (e.g.
`~/.local/bin`) to the same `dist/cli.js`. Run `which usher` and
`which usher-point` to confirm both resolve to this checkout. To undo:
`npm unlink -g usher-point` (removes both names, since they share one
package).

There is no test suite yet. The closest thing to a regression check is
re-running the three routing scenarios below plus `usher-point doctor`, and
smoke-testing the interactive REPL by piping stdin, e.g.
`printf 'fix a typo in README\nn\nexit\n' | usher` — see `docs/USAGE.md` for
the full REPL smoke-test commands.

## Adding a new routing rule

Most routing changes need no code at all — edit `usher-point.config.json`:

```jsonc
{
  "rules": [
    { "id": "quick-inline", "when": { "multiFile": false, "needsIsolation": false }, "target": "claudeInline" },
    // ...
  ]
}
```

- Rules are evaluated top to bottom; the **first** `when` clause that matches
  the task's `TaskShape` wins (`src/routing/decide.ts`).
- `when` fields (`multiFile`, `multiRepo`, `needsIsolation`) are all
  optional — omit a field to make it a wildcard for that rule.
- `target` must be one of `claudeInline`, `codexCli`, `orcaWorktree`
  (validated by the zod schema in `src/config/schema.ts` — an invalid config
  fails loudly at startup, not mid-routing).
- If nothing matches, the fallback is always `claudeInline` (the
  cheapest/safest target) — this is intentional, not a bug to route around.
- `usher-point.config.json` is read fresh on every invocation, so no rebuild
  is needed after editing it.

If a new rule needs a signal `classify.ts` doesn't already compute (e.g. a
new keyword category beyond `isMultiFile`/`isMultiRepo`/`needsIsolation`),
that's a code change in `src/routing/classify.ts` and `src/routing/types.ts`
(`TaskShape`) — keep it an explicit, inspectable check, not a scored/ML
heuristic.

## Adding a new adapter

Adapters live in `src/adapters/` and follow one pattern: a pure function
that takes target config + task context and returns a `CommandSpec`
(`src/exec/run-command.ts`) — it never spawns a process itself. See
`claude-adapter.ts` for the simplest example.

Steps:
1. Add the new config target name to `ConfigTargetNameSchema` and
   `TargetConfigSchema` in `src/config/schema.ts` if it needs its own
   defaults.
2. Add a `<name>-adapter.ts` file exporting a `build<Name>Command(...)`
   function returning a `CommandSpec`. Set `stdin: "ignore"` for any
   non-interactive subprocess (see the Codex adapter's comment on the
   stdin-hang gotcha) or `"inherit"` for one that expects a live terminal.
3. Wire the new case into `buildCommandSpec` in `src/cli.ts`.
4. If the new tool's own subcommand syntax is unstable across its releases
   (as with Orca), do not hardcode it — resolve it from a cached, refreshable
   reference the way `orca-adapter.ts` does, and fail closed with a clear
   "run `usher-point doctor`"-style message if the cache is missing.

## Engineering conventions

- **TypeScript strict mode.** `tsconfig.json` has `strict`,
  `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` on. Keep new
  code compiling clean under these — don't loosen them to make a change fit.
- **No unnecessary abstractions.** Each module does one job (routing,
  skill selection, or process execution) with plain functions and
  interfaces — no framework, no dependency injection container, no class
  hierarchy where a function will do.
- **First-match-wins, explicit routing — no hidden ML/black-box logic.**
  Every routing signal in `classify.ts` is an inspectable keyword/flag
  check, and `usher-point route --verbose` prints the full `TaskShape` plus
  which rule id matched. Do not introduce scoring, weighting, or a model
  into the routing decision itself; that opacity is exactly what this tool
  exists to avoid.
