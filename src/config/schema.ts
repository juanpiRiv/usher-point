import { z } from "zod";

/**
 * Zod schema for jev.config.json. This is the single source of truth for the
 * shape of jev's ruleset — everything downstream (routing, adapters) trusts
 * data that already passed this validation.
 */

export const TargetConfigSchema = z.object({
  command: z.string().min(1),
  defaultFlags: z.array(z.string()).optional(),
  defaultModel: z.string().optional(),
  defaultEffort: z.string().optional(),
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

export const JevConfigSchema = z.object({
  targets: z.object({
    claudeInline: TargetConfigSchema,
    codexCli: TargetConfigSchema,
    orcaWorktree: TargetConfigSchema,
  }),
  rules: z.array(RuleSchema).min(1),
  knownRepos: z.record(z.string(), KnownRepoSchema),
});
export type JevConfig = z.infer<typeof JevConfigSchema>;
