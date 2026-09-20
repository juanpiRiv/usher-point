export type RouteTarget = "claude-inline" | "codex-cli" | "orca-worktree";

/** What classify.ts derives from the task text + CLI flags. */
export interface TaskShape {
  taskText: string;
  isMultiFile: boolean;
  isMultiRepo: boolean;
  needsIsolation: boolean;
  explicitTarget?: RouteTarget;
  repoName?: string;
}

/** What decide.ts produces after walking usher-point.config.json.rules. */
export interface Decision {
  target: RouteTarget;
  ruleId: string;
  sandbox?: string;
  spawnAgent?: string;
  repoName?: string;
  /** Set only when the decision came from routing/jev-model.ts instead of a config rule. */
  confidence?: number;
  reasoning?: string;
}
