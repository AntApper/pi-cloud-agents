import { z } from "zod";

/**
 * Regex for valid secret names in repo configuration.
 * Must match either:
 * 1. An absolute stack-scoped path: /pi-cloud-agents/<stack>/...
 * 2. A safe relative secret identifier without path traversal: [a-zA-Z0-9_.-]+
 */
export const REPO_SECRET_NAME_REGEX =
  /^(?:\/pi-cloud-agents\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+|[a-zA-Z0-9_.-]+)$/;

/**
 * AWS configuration block for local config.
 */
export const AwsConfigSchema = z.object({
  profile: z.string().min(1).optional(),
  region: z.string().min(1).default("us-east-1"),
});

export type AwsConfig = z.infer<typeof AwsConfigSchema>;

/**
 * MicroVM runner image configuration block.
 */
export const ImageConfigSchema = z.object({
  name: z.string().min(1).default("pi-cloud-agents-runner"),
  memoryMiB: z.number().int().positive().default(4096),
});

export type ImageConfig = z.infer<typeof ImageConfigSchema>;

/**
 * Model selection configuration.
 */
export const ModelConfigSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/**
 * Idle timing policies in minutes.
 */
export const IdlePolicyMinutesSchema = z.object({
  suspendAfterMin: z.number().int().nonnegative().default(15),
  terminateAfterSuspendedMin: z.number().int().nonnegative().default(120),
});

export type IdlePolicyMinutes = z.infer<typeof IdlePolicyMinutesSchema>;

/**
 * Operational defaults in local config.
 */
export const LocalDefaultsSchema = z.object({
  model: ModelConfigSchema.default({
    provider: "anthropic",
    id: "claude-sonnet-4-6",
  }),
  maxDurationHours: z.number().int().positive().max(8).default(4),
  idle: IdlePolicyMinutesSchema.default({
    suspendAfterMin: 15,
    terminateAfterSuspendedMin: 120,
  }),
  maxConcurrent: z.number().int().positive().default(3),
  archiveRetentionDays: z.number().int().nonnegative().default(30),
  controllerCadenceMin: z.number().int().positive().default(1),
});

export type LocalDefaults = z.infer<typeof LocalDefaultsSchema>;

/**
 * Provider sync and OAuth opt-in configuration.
 */
export const ProvidersConfigSchema = z.object({
  synced: z.array(z.string().min(1)).default([]),
  oauthOptIn: z.array(z.string().min(1)).default([]),
  bedrockRole: z.boolean().default(false),
  syncedAt: z.string().datetime().optional(),
});

export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;

/**
 * GitHub integration settings in local config.
 */
export const GithubConfigSchema = z.object({
  mode: z.enum(["secret", "none"]).default("none"),
  secretName: z.string().min(1).optional(),
});

export type GithubConfig = z.infer<typeof GithubConfigSchema>;

/**
 * Name of the core CloudFormation stack when the user has not chosen one. Secrets Manager names
 * (`pi-cloud-agents/<stack>/...`), the image stack (`<stack>-image`) and every fallback in `core/`
 * derive from this single constant.
 */
export const DEFAULT_STACK_NAME = "pi-cloud-agents-core";

/**
 * Local user configuration schema (stored at ~/.pi/agent/pi-cloud-agents.json).
 */
export const LocalConfigSchema = z.object({
  aws: AwsConfigSchema.default({
    region: "us-east-1",
  }),
  stackName: z.string().min(1).default(DEFAULT_STACK_NAME),
  image: ImageConfigSchema.default({
    name: "pi-cloud-agents-runner",
    memoryMiB: 4096,
  }),
  defaults: LocalDefaultsSchema.default({
    model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    maxDurationHours: 4,
    idle: { suspendAfterMin: 15, terminateAfterSuspendedMin: 120 },
    maxConcurrent: 3,
    archiveRetentionDays: 30,
    controllerCadenceMin: 1,
  }),
  providers: ProvidersConfigSchema.default({
    synced: [],
    oauthOptIn: [],
    bedrockRole: false,
  }),
  github: GithubConfigSchema.default({
    mode: "none",
  }),
  kmsKeyArn: z.string().min(1).optional(),
  egressConnectorArn: z.string().min(1).optional(),
});

export type LocalConfig = z.infer<typeof LocalConfigSchema>;

/**
 * Default LocalConfig instance with all default fields populated.
 */
export const DEFAULT_LOCAL_CONFIG: LocalConfig = LocalConfigSchema.parse({});

/**
 * Per-repository configuration schema (stored at <repo>/.pi/cloud-agents.json).
 */
export const RepoConfigSchema = z.object({
  install: z.string().min(1).optional(),
  start: z.string().min(1).optional(),
  env: z.record(z.string()).optional(),
  secrets: z
    .array(
      z
        .string()
        .regex(
          REPO_SECRET_NAME_REGEX,
          "Secret name must be a relative identifier or match '/pi-cloud-agents/<stack>/...'",
        ),
    )
    .optional(),
  model: ModelConfigSchema.optional(),
  memoryMiB: z.number().int().positive().optional(),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;
