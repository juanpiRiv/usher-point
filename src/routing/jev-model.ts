import { z } from "zod";
import type { JevConfig, JevModelConfig } from "../config/schema";
import type { Decision, RouteTarget } from "./types";

/**
 * Optional alternative decision source: TypeSafe AI's "Jev" model
 * (docs.typesafe.ai), a "System One Model" purpose-built for fast
 * structured/typed decisions, reached only through OpenRouter's standard
 * chat-completions API (https://openrouter.ai/api/v1/chat/completions).
 *
 * This is deliberately kept in routing/ rather than adapters/ — unlike
 * claude-adapter.ts/codex-adapter.ts/orca-adapter.ts it never spawns a
 * process; it makes one HTTP call to *decide*, then hands the result off to
 * the exact same adapters the heuristic path uses.
 *
 * Fail-closed philosophy (same as the Orca adapter's cache-miss handling):
 * any problem at all — Jev disabled, no API key, network error, non-2xx,
 * malformed/unparseable response — returns null so the caller can fall back
 * to the local heuristic. This module NEVER throws and NEVER crashes the CLI.
 */

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 10_000;

const VALID_TARGETS: readonly RouteTarget[] = ["claude-inline", "codex-cli", "orca-worktree"];

const JevModelResponseSchema = z.object({
  target: z.enum(["claude-inline", "codex-cli", "orca-worktree"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1),
});

export type JevAvailability = { available: true } | { available: false; reason: string };

/** Cheap, local, no-network check — used both before calling out and by `usher-point doctor`. */
export function checkJevAvailability(cfg: JevModelConfig): JevAvailability {
  if (!cfg.enabled) {
    return { available: false, reason: "jevModel.enabled is false in usher-point.config.json" };
  }
  const apiKey = process.env[cfg.apiKeyEnvVar];
  if (!apiKey) {
    return { available: false, reason: `environment variable ${cfg.apiKeyEnvVar} is not set` };
  }
  return { available: true };
}

export type JevCallResult = { ok: true; decision: Decision } | { ok: false; reason: string };

interface TargetDescription {
  target: RouteTarget;
  description: string;
}

function describeTargets(targets: JevConfig["targets"]): TargetDescription[] {
  return [
    { target: "claude-inline", description: targets.claudeInline.description ?? "claude-inline" },
    { target: "codex-cli", description: targets.codexCli.description ?? "codex-cli" },
    { target: "orca-worktree", description: targets.orcaWorktree.description ?? "orca-worktree" },
  ];
}

function buildPrompt(taskText: string, targets: JevConfig["targets"]): string {
  const options = describeTargets(targets)
    .map((t) => `- "${t.target}": ${t.description}`)
    .join("\n");

  return [
    "You are a routing engine for the usher-point CLI. Given a task description,",
    "choose exactly one of the following targets:",
    options,
    "",
    `Task: ${JSON.stringify(taskText)}`,
    "",
    "Respond with ONLY a single JSON object, no prose, no markdown fences, matching",
    'exactly this shape: {"target": "<one of the target names above>", "confidence": <number 0-1>, "reasoning": "<one sentence>"}.',
  ].join("\n");
}

/** Extracts the first top-level JSON object found in free-form model output. */
function extractJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    // fall through to brace-matching below
  }
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object found in model response");
  }
  return JSON.parse(content.slice(start, end + 1));
}

/**
 * Runs the actual OpenRouter call and returns a discriminated result (never
 * throws). `decideViaJevModel` below is the fail-closed-to-null wrapper most
 * callers want; `probeJevModel` (used by `usher-point doctor`) exposes the
 * failure reason for diagnostics.
 */
export async function probeJevModel(taskText: string, cfg: JevModelConfig, targets: JevConfig["targets"]): Promise<JevCallResult> {
  const availability = checkJevAvailability(cfg);
  if (!availability.available) {
    return { ok: false, reason: availability.reason };
  }
  const apiKey = process.env[cfg.apiKeyEnvVar] as string;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        max_tokens: 200,
        messages: [{ role: "user", content: buildPrompt(taskText, targets) }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    return { ok: false, reason: `request to OpenRouter failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      // ignore — best-effort diagnostics only
    }
    return { ok: false, reason: `OpenRouter responded ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 300)}` : ""}` };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    return { ok: false, reason: `could not parse OpenRouter response body as JSON: ${(err as Error).message}` };
  }

  const content = extractMessageContent(payload);
  if (content === undefined) {
    return { ok: false, reason: "OpenRouter response had no choices[0].message.content" };
  }

  let candidate: unknown;
  try {
    candidate = extractJson(content);
  } catch (err) {
    return { ok: false, reason: `Jev model reply was not valid JSON: ${(err as Error).message}` };
  }

  const parsed = JevModelResponseSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, reason: `Jev model reply failed schema validation: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }

  if (!VALID_TARGETS.includes(parsed.data.target)) {
    return { ok: false, reason: `Jev model returned an unrecognized target: ${String(parsed.data.target)}` };
  }

  const decision: Decision = {
    target: parsed.data.target,
    ruleId: `jev-model:${cfg.model}`,
    confidence: parsed.data.confidence,
    reasoning: parsed.data.reasoning,
  };
  return { ok: true, decision };
}

function extractMessageContent(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  return typeof content === "string" ? content : undefined;
}

/**
 * Fail-closed-to-null decision source: use this from cli.ts/decide.ts. Any
 * failure at all (disabled, no key, network error, bad status, unparseable
 * reply) yields null so the caller can fall back to the local heuristic.
 */
export async function decideViaJevModel(
  taskText: string,
  cfg: JevModelConfig,
  targets: JevConfig["targets"]
): Promise<Decision | null> {
  const result = await probeJevModel(taskText, cfg, targets);
  return result.ok ? result.decision : null;
}
