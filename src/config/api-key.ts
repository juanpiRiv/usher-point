import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Local, persistent fallback storage for the optional Jev/OpenRouter API
 * key, so a user doesn't have to `export OPENROUTER_API_KEY=...` in every
 * shell session. This is the ONLY place usher-point reads or writes that
 * file — jev-model.ts's `checkJevAvailability`/`probeJevModel` and cli.ts's
 * `doctor`/`config` commands all go through `resolveApiKey`/`setApiKey`/
 * `unsetApiKey` here, never duplicating the lookup.
 *
 * Storage location is deliberately OUTSIDE the repo/package
 * (`~/.config/usher-point/config.json`, NOT `usher-point.config.json`,
 * which is versioned/committed) since this file holds a real secret and
 * must never be committed. It is written with `0o600` permissions (owner
 * read/write only) immediately after every write.
 *
 * Resolution order (see resolveApiKey): `process.env[envVarName]` always
 * wins (an explicit session override), falling back to this local file,
 * falling back to "not configured". This centralizes what
 * `jev-model.ts`'s `checkJevAvailability`/`probeJevModel` used to do with a
 * bare `process.env[apiKeyEnvVar]` read, and is also what `usher-point
 * doctor` and `usher-point config status` report against — same rule,
 * one implementation.
 *
 * Hard rule (same as CLAUDE.md's for the env var): the key value itself is
 * never logged, printed, or included in an error message anywhere in this
 * module or its callers.
 */

export function localConfigDir(): string {
  return path.join(os.homedir(), ".config", "usher-point");
}

export function localConfigPath(): string {
  return path.join(localConfigDir(), "config.json");
}

type LocalKeyStore = Record<string, string>;

function readLocalKeyStore(): LocalKeyStore {
  let raw: string;
  try {
    raw = fs.readFileSync(localConfigPath(), "utf-8");
  } catch {
    // Missing file (never configured, or already unset) — empty store.
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as LocalKeyStore;
    }
    return {};
  } catch {
    // Corrupt/non-JSON file — treat as empty rather than crashing the CLI.
    return {};
  }
}

function writeLocalKeyStore(store: LocalKeyStore): void {
  const dir = localConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = localConfigPath();
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's `mode` option only applies when the file is newly
  // created; chmod explicitly afterward so an overwrite of a pre-existing
  // file (or one created under a looser umask) always ends up 0o600 too —
  // this file holds a real secret.
  fs.chmodSync(file, 0o600);
}

export type ApiKeySource = "environment variable" | "local config file" | "not configured";

export interface ApiKeyResolution {
  value: string | undefined;
  source: ApiKeySource;
}

/**
 * Resolution order: `process.env[envVarName]` (explicit session override)
 * always wins over the local persistent file; if neither is set, "not
 * configured". Never throws, never logs the value.
 */
export function resolveApiKey(envVarName: string): ApiKeyResolution {
  const fromEnv = process.env[envVarName];
  if (fromEnv) {
    return { value: fromEnv, source: "environment variable" };
  }
  const fromFile = readLocalKeyStore()[envVarName];
  if (fromFile) {
    return { value: fromFile, source: "local config file" };
  }
  return { value: undefined, source: "not configured" };
}

/** Writes `{ [envVarName]: value }` into the local persistent file (0o600). */
export function setApiKey(envVarName: string, value: string): void {
  const store = readLocalKeyStore();
  store[envVarName] = value;
  writeLocalKeyStore(store);
}

/**
 * Removes `envVarName` from the local persistent file. If that empties the
 * store entirely, deletes the file rather than leaving an empty `{}` on
 * disk.
 */
export function unsetApiKey(envVarName: string): void {
  const store = readLocalKeyStore();
  if (!(envVarName in store)) return;
  delete store[envVarName];
  if (Object.keys(store).length === 0) {
    try {
      fs.unlinkSync(localConfigPath());
    } catch {
      // Already gone — fine.
    }
    return;
  }
  writeLocalKeyStore(store);
}
