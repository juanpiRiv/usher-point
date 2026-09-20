import * as fs from "node:fs";
import * as path from "node:path";
import { JevConfigSchema, type JevConfig } from "./schema";

/**
 * jev is installed via `npm link`, so it can be invoked from any cwd. Config
 * therefore lives next to the installed package (this file compiles to
 * dist/config/load.js, so the package root is two levels up), not in the
 * caller's cwd. JEV_CONFIG_PATH lets that be overridden for testing.
 */
const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");

export function packageRoot(): string {
  return PACKAGE_ROOT;
}

export function resolveConfigPath(): string {
  return process.env["JEV_CONFIG_PATH"] ?? path.join(PACKAGE_ROOT, "jev.config.json");
}

export function loadConfig(): JevConfig {
  const configPath = resolveConfigPath();

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    throw new Error(
      `jev: could not read config at ${configPath}\n  ${(err as Error).message}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`jev: ${configPath} is not valid JSON\n  ${(err as Error).message}`);
  }

  const result = JevConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`jev: config at ${configPath} failed validation:\n${issues}`);
  }

  return result.data;
}
