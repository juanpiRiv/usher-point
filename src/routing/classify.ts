import type { JevConfig } from "../config/schema";
import type { RouteTarget, TaskShape } from "./types";

/**
 * Rule-based (no ML) task classification. Every signal here is an explicit,
 * inspectable keyword/flag check — `jev route --verbose` can print exactly
 * why a TaskShape came out the way it did.
 */

const MULTI_FILE_KEYWORDS = ["across", "refactor", "multiple files", "multi-file"];
const RISKY_VERBS = ["migrate", "rewrite", "delete"];

const VALID_TARGETS: readonly RouteTarget[] = ["claude-inline", "codex-cli", "orca-worktree"];

export interface ClassifyFlags {
  repo?: string;
  target?: string;
  worktree?: boolean;
}

export function classify(taskText: string, flags: ClassifyFlags, config: JevConfig): TaskShape {
  const lowerText = taskText.toLowerCase();

  const isMultiFile = MULTI_FILE_KEYWORDS.some((kw) => lowerText.includes(kw));
  const hasRiskyVerb = RISKY_VERBS.some((verb) => lowerText.includes(verb));

  const repoName = flags.repo ?? findKnownRepoMention(lowerText, config);
  const isMultiRepo = repoName !== undefined;

  const needsIsolation = Boolean(flags.worktree) || isMultiRepo || hasRiskyVerb;

  const explicitTarget = resolveExplicitTarget(flags.target);

  const shape: TaskShape = {
    taskText,
    isMultiFile,
    isMultiRepo,
    needsIsolation,
  };
  if (explicitTarget !== undefined) shape.explicitTarget = explicitTarget;
  if (repoName !== undefined) shape.repoName = repoName;
  return shape;
}

function resolveExplicitTarget(target: string | undefined): RouteTarget | undefined {
  if (!target) return undefined;
  const match = VALID_TARGETS.find((candidate) => candidate === target);
  if (!match) {
    throw new Error(
      `jev: invalid --target "${target}". Expected one of: ${VALID_TARGETS.join(", ")}.`
    );
  }
  return match;
}

function findKnownRepoMention(lowerText: string, config: JevConfig): string | undefined {
  for (const repoName of Object.keys(config.knownRepos)) {
    if (lowerText.includes(repoName.toLowerCase())) {
      return repoName;
    }
  }
  return undefined;
}
