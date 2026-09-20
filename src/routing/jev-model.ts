import { z } from "zod";
import { resolveApiKey } from "../config/api-key";
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
 * Unified decision: when Jev is the active engine, ONE call to Jev decides
 * everything usher-point needs — not just `target`, but also which of the
 * candidate skills are relevant (replacing skills/select.ts's keyword-overlap
 * ranking for that call) and, optionally, a model/effort override for the
 * resolved target. The candidate skill list itself is still gathered by
 * skills/ code (registry-reader.ts / fallback-scan.ts, via cli.ts) — this
 * module only receives the already-gathered candidates as plain data and
 * never imports from skills/, keeping the routing/skills module boundary
 * intact. The heuristic engine (classify.ts + decide.ts + skills/select.ts)
 * is completely unaffected by this — it's a separate call path.
 *
 * Fail-closed philosophy (same as the Orca adapter's cache-miss handling):
 * any problem at all — Jev disabled, no API key, network error, non-2xx,
 * malformed/unparseable response — returns null so the caller can fall back
 * to the local heuristic (both routing AND skill selection revert together;
 * there is no partial/mixed state). This module NEVER throws and NEVER
 * crashes the CLI.
 */

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_TOKENS = 600;

const VALID_TARGETS: readonly RouteTarget[] = ["claude-inline", "codex-cli", "orca-worktree"];

/**
 * Minimal, skills-module-agnostic shape for a candidate skill Jev is told
 * about. cli.ts maps skills/select.ts's SkillCandidate into this shape
 * before calling decideViaJevModel — this module never imports from skills/.
 */
export interface JevSkillCandidate {
  name: string;
  path: string;
  description: string;
}

const JevModelResponseSchema = z.object({
  target: z.enum(["claude-inline", "codex-cli", "orca-worktree"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1),
  /** Subset of the candidate skills' `name`/`path` Jev judges relevant. */
  skills: z.array(z.string()).default([]),
  /** Omit entirely, or omit its inner fields, when no override is warranted. */
  modelOverride: z
    .object({
      model: z.string().min(1).optional(),
      effort: z.string().min(1).optional(),
    })
    .optional(),
});

export type JevAvailability = { available: true } | { available: false; reason: string };

/**
 * Cheap, local, no-network check — used both before calling out and by
 * `usher-point doctor`. The key itself is resolved via config/api-key.ts's
 * `resolveApiKey`: `process.env[cfg.apiKeyEnvVar]` wins if set, otherwise
 * the local `~/.config/usher-point/config.json` file (written by
 * `usher-point config set-key`) is checked before giving up.
 */
export function checkJevAvailability(cfg: JevModelConfig): JevAvailability {
  if (!cfg.enabled) {
    return { available: false, reason: "jevModel.enabled is false in usher-point.config.json" };
  }
  const { value: apiKey } = resolveApiKey(cfg.apiKeyEnvVar);
  if (!apiKey) {
    return {
      available: false,
      reason: `environment variable ${cfg.apiKeyEnvVar} is not set (and no key found in ~/.config/usher-point/config.json — see \`usher-point config set-key\`)`,
    };
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

function describeSkillCandidates(candidates: readonly JevSkillCandidate[]): string {
  if (candidates.length === 0) return "(no candidate skills available)";
  return candidates
    .map((c) => `- "${c.name}" (${c.path}): ${c.description || "(no description)"}`)
    .join("\n");
}

function buildPrompt(
  taskText: string,
  targets: JevConfig["targets"],
  skillCandidates: readonly JevSkillCandidate[]
): string {
  const options = describeTargets(targets)
    .map((t) => `- "${t.target}": ${t.description}`)
    .join("\n");
  const skillsList = describeSkillCandidates(skillCandidates);

  return [
    "You are a unified decision engine for the usher-point CLI. Given a task",
    "description, decide ALL of the following in one response:",
    "",
    "1. Which target should run the task — choose exactly one of:",
    options,
    "",
    "2. Which of these candidate skills (if any) are relevant to the task.",
    "Return each relevant skill by its exact name or path as given below —",
    "never invent a skill that isn't listed:",
    skillsList,
    "",
    "3. Optionally, a model/effort override for the chosen target, only if the",
    "task clearly needs a different underlying model or reasoning effort than",
    "that target's configured default. Omit modelOverride entirely (or its",
    "model/effort fields) when no override is warranted — this is the common",
    "case.",
    "",
    `Task: ${JSON.stringify(taskText)}`,
    "",
    "Respond with ONLY a single JSON object, no prose, no markdown fences,",
    "matching exactly this shape:",
    '{"target": "<one of the target names above>", "confidence": <number 0-1>, "reasoning": "<one sentence>", "skills": ["<candidate name or path>", ...], "modelOverride": {"model": "<optional>", "effort": "<optional>"}}',
    '"skills" may be an empty array. Omit "modelOverride" (or leave it out) when unused.',
  ].join("\n");
}

/**
 * Maps Jev's returned skill name/path strings back to the exact candidates
 * it was shown, dropping anything that doesn't match a known candidate
 * (fail-closed against a hallucinated/unknown skill reference) and
 * de-duplicating by path.
 */
function matchSkills(
  returned: readonly string[],
  candidates: readonly JevSkillCandidate[]
): { path: string; reason?: string }[] {
  const byName = new Map(candidates.map((c) => [c.name, c] as const));
  const byPath = new Map(candidates.map((c) => [c.path, c] as const));
  const seen = new Set<string>();
  const matched: { path: string; reason?: string }[] = [];

  for (const entry of returned) {
    const candidate = byName.get(entry) ?? byPath.get(entry);
    if (!candidate || seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    matched.push({ path: candidate.path });
  }
  return matched;
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
export async function probeJevModel(
  taskText: string,
  cfg: JevModelConfig,
  targets: JevConfig["targets"],
  skillCandidates: readonly JevSkillCandidate[] = []
): Promise<JevCallResult> {
  const availability = checkJevAvailability(cfg);
  if (!availability.available) {
    return { ok: false, reason: availability.reason };
  }
  // checkJevAvailability() above already confirmed resolveApiKey() returns a
  // value for this env var name, via env or the local config file.
  const apiKey = resolveApiKey(cfg.apiKeyEnvVar).value as string;

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
        max_tokens: MAX_RESPONSE_TOKENS,
        messages: [{ role: "user", content: buildPrompt(taskText, targets, skillCandidates) }],
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
    skills: matchSkills(parsed.data.skills, skillCandidates),
  };
  const override = parsed.data.modelOverride;
  if (override && (override.model !== undefined || override.effort !== undefined)) {
    decision.modelOverride = {};
    if (override.model !== undefined) decision.modelOverride.model = override.model;
    if (override.effort !== undefined) decision.modelOverride.effort = override.effort;
  }
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
 * reply) yields null so the caller can fall back to the local heuristic —
 * including its skill selection (cli.ts must call skills/select.ts on that
 * path; it must not use a partial Jev decision).
 *
 * `skillCandidates` should be the raw, unranked candidate list gathered by
 * skills/ code (see skills/select.ts's gatherSkillCandidates/capCandidates)
 * — pass [] to skip skill selection for this call (e.g. `usher-point doctor`'s
 * trivial connectivity probe).
 */
export async function decideViaJevModel(
  taskText: string,
  cfg: JevModelConfig,
  targets: JevConfig["targets"],
  skillCandidates: readonly JevSkillCandidate[] = []
): Promise<Decision | null> {
  const result = await probeJevModel(taskText, cfg, targets, skillCandidates);
  return result.ok ? result.decision : null;
}
