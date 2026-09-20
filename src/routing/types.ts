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
  /**
   * Skills judged relevant to this decision. On the heuristic path this is
   * always `[]` here — skills/select.ts's keyword-overlap ranking produces
   * the actual resolved skill list separately (see cli.ts#resolveRoute). On
   * the Jev path, routing/jev-model.ts's decideViaJevModel() populates this
   * directly from Jev's single unified response, replacing the keyword
   * matcher for that call.
   */
  skills: { path: string; reason?: string }[];
  /**
   * Set only when the decision came from routing/jev-model.ts and Jev judged
   * that the resolved target's configured default model/effort should be
   * adjusted for this specific task. Deliberately generic (not tied to any
   * one target) — currently only codexCli's TargetConfig.defaultModel/
   * defaultEffort are read by an adapter (codex-adapter.ts), but the field
   * itself makes no assumption about which target it applies to.
   */
  modelOverride?: { model?: string; effort?: string };
}
