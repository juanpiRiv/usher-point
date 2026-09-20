import { z } from "zod";

/**
 * Zod schema for usher-point.config.json. This is the single source of truth
 * for the shape of usher-point's ruleset — everything downstream (routing, adapters) trusts
 * data that already passed this validation.
 */

export const TargetConfigSchema = z.object({
  command: z.string().min(1),
  defaultFlags: z.array(z.string()).optional(),
  defaultModel: z.string().optional(),
  defaultEffort: z.string().optional(),
  /** One-line, human-readable meaning of this target. Reused verbatim by
   * routing/jev-model.ts when asking the Jev model to choose a target, so it
   * never has to duplicate these descriptions in code. */
  description: z.string().optional(),
});
export type TargetConfig = z.infer<typeof TargetConfigSchema>;

export const ConfigTargetNameSchema = z.enum(["claudeInline", "codexCli", "orcaWorktree"]);
export type ConfigTargetName = z.infer<typeof ConfigTargetNameSchema>;

export const RuleWhenSchema = z.object({
  multiFile: z.boolean().optional(),
  multiRepo: z.boolean().optional(),
  needsIsolation: z.boolean().optional(),
});
export type RuleWhen = z.infer<typeof RuleWhenSchema>;

export const RuleSchema = z.object({
  id: z.string().min(1),
  when: RuleWhenSchema,
  target: ConfigTargetNameSchema,
  sandbox: z.string().optional(),
  spawnAgent: z.string().optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

export const KnownRepoSchema = z.object({
  worktreeRoot: z.string().min(1),
});
export type KnownRepo = z.infer<typeof KnownRepoSchema>;

/**
 * Optional TypeSafe AI "Jev" routing engine config — an alternative decision
 * source to the hand-written heuristic in classify.ts/decide.ts. Jev is a
 * third-party "System One Model" reached only via OpenRouter's standard
 * chat-completions API. The API key itself is NEVER stored here — only the
 * name of the environment variable to read it from at call time.
 */
export const JevModelConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    model: z.string().min(1).default("typesafe/jev-1.13"),
    apiKeyEnvVar: z.string().min(1).default("OPENROUTER_API_KEY"),
  })
  .default({ enabled: false, model: "typesafe/jev-1.13", apiKeyEnvVar: "OPENROUTER_API_KEY" });
export type JevModelConfig = z.infer<typeof JevModelConfigSchema>;

export const JevConfigSchema = z.object({
  targets: z.object({
    claudeInline: TargetConfigSchema,
    codexCli: TargetConfigSchema,
    orcaWorktree: TargetConfigSchema,
  }),
  rules: z.array(RuleSchema).min(1),
  knownRepos: z.record(z.string(), KnownRepoSchema),
  jevModel: JevModelConfigSchema,
});
export type JevConfig = z.infer<typeof JevConfigSchema>;
