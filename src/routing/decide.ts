import type { JevConfig, Rule } from "../config/schema";
import type { Decision, RouteTarget, TaskShape } from "./types";

/**
 * Decision engine: walks usher-point.config.json.rules in order, first match wins.
 * An explicit --target flag always wins outright, before any rule is even
 * consulted. If nothing matches, fall back to the safest/cheapest target
 * (claude-inline) rather than guessing.
 *
 * Decision.skills is always [] here — decide.ts never selects skills itself.
 * On this (heuristic) path cli.ts#resolveRoute separately calls
 * skills/select.ts's keyword-overlap ranking to produce the resolved skill
 * list; only routing/jev-model.ts's decideViaJevModel() populates
 * Decision.skills directly.
 */

const CONFIG_TARGET_TO_ROUTE_TARGET: Record<Rule["target"], RouteTarget> = {
  claudeInline: "claude-inline",
  codexCli: "codex-cli",
  orcaWorktree: "orca-worktree",
};

const FALLBACK_TARGET: RouteTarget = "claude-inline";
export const FALLBACK_RULE_ID = "fallback-claude-inline";
export const EXPLICIT_TARGET_RULE_ID = "explicit-target-flag";

export function decide(shape: TaskShape, config: JevConfig): Decision {
  if (shape.explicitTarget !== undefined) {
    const decision: Decision = {
      target: shape.explicitTarget,
      ruleId: EXPLICIT_TARGET_RULE_ID,
      skills: [],
    };
    if (shape.repoName !== undefined) decision.repoName = shape.repoName;
    return decision;
  }

  for (const rule of config.rules) {
    if (!ruleMatches(rule, shape)) continue;

    const decision: Decision = {
      target: CONFIG_TARGET_TO_ROUTE_TARGET[rule.target],
      ruleId: rule.id,
      skills: [],
    };
    if (rule.sandbox !== undefined) decision.sandbox = rule.sandbox;
    if (rule.spawnAgent !== undefined) decision.spawnAgent = rule.spawnAgent;
    if (shape.repoName !== undefined) decision.repoName = shape.repoName;
    return decision;
  }

  const fallback: Decision = { target: FALLBACK_TARGET, ruleId: FALLBACK_RULE_ID, skills: [] };
  if (shape.repoName !== undefined) fallback.repoName = shape.repoName;
  return fallback;
}

function ruleMatches(rule: Rule, shape: TaskShape): boolean {
  const { when } = rule;
  if (when.multiFile !== undefined && when.multiFile !== shape.isMultiFile) return false;
  if (when.multiRepo !== undefined && when.multiRepo !== shape.isMultiRepo) return false;
  if (when.needsIsolation !== undefined && when.needsIsolation !== shape.needsIsolation) {
    return false;
  }
  return true;
}
