import * as fs from "node:fs";
import * as path from "node:path";
import { JevConfigSchema, type JevConfig } from "./schema";

/**
 * usher-point is installed via `npm link`, so it can be invoked from any cwd.
 * Config therefore lives next to the installed package (this file compiles
 * to dist/config/load.js, so the package root is two levels up), not in the
 * caller's cwd. USHER_POINT_CONFIG_PATH lets that be overridden for testing.
 *
 * Back-compat: this project was previously named `jev`. If
 * usher-point.config.json isn't found next to the package but a leftover
 * jev.config.json is, we fall back to it for one release rather than
 * breaking an existing setup outright.
 */
const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const CONFIG_FILENAME = "usher-point.config.json";
const LEGACY_CONFIG_FILENAME = "jev.config.json";

export function packageRoot(): string {
  return PACKAGE_ROOT;
}

export function resolveConfigPath(): string {
  const override = process.env["USHER_POINT_CONFIG_PATH"];
  if (override) return override;

  const primary = path.join(PACKAGE_ROOT, CONFIG_FILENAME);
  if (fs.existsSync(primary)) return primary;

  const legacy = path.join(PACKAGE_ROOT, LEGACY_CONFIG_FILENAME);
  if (fs.existsSync(legacy)) return legacy;

  return primary;
}

export function loadConfig(): JevConfig {
  const configPath = resolveConfigPath();

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    throw new Error(
      `usher-point: could not read config at ${configPath}\n  ${(err as Error).message}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`usher-point: ${configPath} is not valid JSON\n  ${(err as Error).message}`);
  }

  const result = JevConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`usher-point: config at ${configPath} failed validation:\n${issues}`);
  }

  return result.data;
}
