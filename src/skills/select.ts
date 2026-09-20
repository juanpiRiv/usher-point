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
  score: number;
  source: "registry" | "fallback";
}

const DEFAULT_TOP_N = 5;

export function selectSkills(taskText: string, cwd: string, topN = DEFAULT_TOP_N): SkillMatch[] {
  const keywords = tokenize(taskText);

  const registryPath = findRegistryPath(cwd);
  if (registryPath) {
    const entries = readRegistry(registryPath);
    return rank(
      entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        text: `${entry.name} ${entry.description}`,
        source: "registry" as const,
      })),
      keywords
    ).slice(0, topN);
  }

  const scanned = scanFallbackSkills();
  return rank(
    scanned.map((skill) => ({
      name: skill.name,
      path: skill.path,
      text: `${skill.name} ${skill.description}`,
      source: "fallback" as const,
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
