import * as path from "node:path";
import { findRegistryPath, readRegistry } from "./registry-reader";
import { scanFallbackSkills } from "./fallback-scan";

/**
 * Combines the registry (preferred) and the fallback scan (used only when no
 * registry exists in cwd) into a single ranked list. Output is always just
 * paths to SKILL.md — usher-point never injects skill content into a prompt itself,
 * matching the convention already used by skill-registry.
 */

export interface SkillMatch {
  name: string;
  path: string;
  /** Keyword-overlap score. Absent for skills selected by routing/jev-model.ts
   * (source "jev-model"), which doesn't produce a comparable numeric score. */
  score?: number;
  source: "registry" | "fallback" | "jev-model";
  /** Only ever set for source "jev-model", if Jev supplied one. */
  reason?: string;
}

const DEFAULT_TOP_N = 5;

/** Raw candidate skill entry, before any keyword-overlap ranking. */
export interface SkillCandidate {
  name: string;
  path: string;
  description: string;
  source: "registry" | "fallback";
}

/**
 * Gathers the full, unranked candidate list from the registry (preferred) or
 * the fallback scan — the same two sources selectSkills() ranks, exposed
 * separately so callers (routing/jev-model.ts's caller in cli.ts) can hand
 * Jev the raw candidates without running the keyword-overlap scoring below.
 */
export function gatherSkillCandidates(cwd: string): SkillCandidate[] {
  const registryPath = findRegistryPath(cwd);
  if (registryPath) {
    return readRegistry(registryPath).map((entry) => ({
      name: entry.name,
      path: entry.path,
      description: entry.description,
      source: "registry" as const,
    }));
  }

  return scanFallbackSkills().map((skill) => ({
    name: skill.name,
    path: skill.path,
    description: skill.description,
    source: "fallback" as const,
  }));
}

const DEFAULT_CANDIDATE_CAP = 50;

/**
 * Caps a candidate list to a sane size before it's embedded in the Jev
 * prompt. Only kicks in when the list is meaningfully larger than `cap`; on
 * this machine (~43 skills under ~/.agents/skills) it's a no-op. When it does
 * trim, it still uses the same cheap keyword-overlap scoring as the
 * heuristic ranker — but only to bound prompt size, never to make the final
 * skill-relevance decision, which stays entirely Jev's call.
 */
export function capCandidates(
  candidates: SkillCandidate[],
  taskText: string,
  cap: number = DEFAULT_CANDIDATE_CAP
): SkillCandidate[] {
  if (candidates.length <= cap) return candidates;

  const keywords = tokenize(taskText);
  return candidates
    .map((candidate) => ({
      candidate,
      score: overlapScore(tokenize(`${candidate.name} ${candidate.description}`), keywords),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map((entry) => entry.candidate);
}

/**
 * Maps a Jev-produced Decision.skills entry list back to display-ready
 * SkillMatch objects, using the same candidate list Jev was shown to recover
 * each skill's display name. Used by cli.ts on the Jev path in place of
 * calling selectSkills().
 */
export function decisionSkillsToMatches(
  decisionSkills: readonly { path: string; reason?: string }[],
  candidates: readonly SkillCandidate[]
): SkillMatch[] {
  const byPath = new Map(candidates.map((c) => [c.path, c] as const));
  return decisionSkills.map((entry) => {
    const candidate = byPath.get(entry.path);
    const match: SkillMatch = {
      name: candidate?.name ?? path.basename(entry.path),
      path: entry.path,
      source: "jev-model",
    };
    if (entry.reason !== undefined) match.reason = entry.reason;
    return match;
  });
}

export function selectSkills(taskText: string, cwd: string, topN = DEFAULT_TOP_N): SkillMatch[] {
  const keywords = tokenize(taskText);
  const candidates = gatherSkillCandidates(cwd);

  return rank(
    candidates.map((candidate) => ({
      name: candidate.name,
      path: candidate.path,
      text: `${candidate.name} ${candidate.description}`,
      source: candidate.source,
    })),
    keywords
  ).slice(0, topN);
}

interface Candidate {
  name: string;
  path: string;
  text: string;
  source: "registry" | "fallback";
}

function rank(candidates: Candidate[], keywords: Set<string>): SkillMatch[] {
  return candidates
    .map((candidate) => ({
      name: candidate.name,
      path: candidate.path,
      source: candidate.source,
      score: overlapScore(tokenize(candidate.text), keywords),
    }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score);
}

function overlapScore(candidateTokens: Set<string>, taskKeywords: Set<string>): number {
  let score = 0;
  for (const token of candidateTokens) {
    if (taskKeywords.has(token)) score += 1;
  }
  return score;
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "of",
  "to",
  "in",
  "on",
  "with",
  "use",
  "when",
  "this",
  "that",
]);

function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
  return new Set(words);
}
