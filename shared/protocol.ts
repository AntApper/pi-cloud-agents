import { z } from "zod";

/**
 * Protocol version constants.
 */
export const PROTOCOL_VERSION = 1 as const;
export const MAX_LAUNCH_PAYLOAD_BYTES = 3584; // 3.5 KB MicroVM run hook payload budget

/**
 * Standard error codes used across the runner API and protocol.
 */
export const ProtocolErrorCode = {
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
  SECRET_MISSING: "SECRET_MISSING",
  INSTALL_TIMEOUT: "INSTALL_TIMEOUT",
  PI_PROCESS_CRASH: "PI_PROCESS_CRASH",
  UNAUTHORIZED: "UNAUTHORIZED",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ProtocolErrorCode = (typeof ProtocolErrorCode)[keyof typeof ProtocolErrorCode];

/**
 * Common regex for run identifier validation.
 * Expected format: run-<alphanumeric/hyphen>
 */
export const RUN_ID_REGEX = /^run-[a-z0-9-]+$/;

/**
 * Thinking budget configuration for models supporting extended thinking.
 */
export const ThinkingConfigSchema = z.union([
  z.boolean(),
  z.object({
    budgetTokens: z.number().int().positive().optional(),
  }),
]);

export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;

/**
 * GitHub credential configuration in LaunchPayload.
 */
export const GithubAuthSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("secret"),
    name: z.string().min(1),
  }),
  z.object({
    mode: z.literal("none"),
  }),
]);

export type GithubAuth = z.infer<typeof GithubAuthSchema>;

/**
 * LaunchPayload schema (v1).
 * Passed to the MicroVM runtime via runHookPayload during RunMicrovm.
 */
export const LaunchPayloadSchema = z.object({
  v: z.literal(1),
  runId: z.string().min(1).regex(RUN_ID_REGEX, {
    message: "runId must match format 'run-[a-z0-9-]+'",
  }),
  owner: z.string().min(1),
  stack: z.object({
    name: z.string().min(1),
    region: z.string().min(1),
    bucket: z.string().min(1),
    prefix: z.string().optional(),
  }),
  repo: z.object({
    url: z.string().min(1),
    ref: z.string().optional(),
    workBranch: z.string().min(1),
    depth: z.number().int().positive().optional(),
  }),
  model: z.object({
    provider: z.string().min(1),
    id: z.string().min(1),
    thinking: ThinkingConfigSchema.optional(),
  }),
  piConfig: z.object({
    bundleKey: z.string().min(1),
    authParams: z.array(z.string().min(1)),
    bedrockRole: z.boolean(),
  }),
  github: GithubAuthSchema,
  options: z.object({
    installTimeoutSec: z.number().int().positive(),
    trustProjectConfig: z.boolean(),
    idleGraceSec: z.number().int().nonnegative(),
    suspendAfterIdleSec: z.number().int().nonnegative(),
    terminateAfterSuspendedSec: z.number().int().nonnegative(),
    autoPush: z.boolean(),
    maxDurationSec: z.number().int().positive().max(28800), // Max 8h hard cap
  }),
  logGroup: z.string().min(1),
});

export type LaunchPayload = z.infer<typeof LaunchPayloadSchema>;

/**
 * Allowed run lifecycle status values.
 */
export const RunStatusSchema = z.enum([
  "launching",
  "running",
  "idle",
  "suspended",
  "completed",
  "failed",
  "terminated",
]);

export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * Timeline transition entry in RunManifest.
 */
export const TimelineEntrySchema = z.object({
  status: z.string().min(1),
  at: z.string().datetime(),
  reason: z.string().optional(),
});

export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

/**
 * Token usage and cost metrics in RunManifest.
 */
export const ManifestUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative().optional(),
});

export type ManifestUsage = z.infer<typeof ManifestUsageSchema>;

/**
 * Git working state in RunManifest.
 */
export const ManifestGitSchema = z.object({
  workBranch: z.string().min(1),
  lastCommit: z.string().optional(),
  prUrl: z.string().url().optional(),
});

export type ManifestGit = z.infer<typeof ManifestGitSchema>;

/**
 * Manifest error shape.
 */
export const ProtocolErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional(),
});

export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

/**
 * Standard error response envelope.
 */
export const ErrorResponseSchema = z.object({
  error: ProtocolErrorSchema,
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/**
 * RunManifest schema (v1).
 * Persisted in S3 as runs/<runId>/manifest.json.
 */
export const RunManifestSchema = z.object({
  v: z.literal(1),
  runId: z.string().min(1).regex(RUN_ID_REGEX, {
    message: "runId must match format 'run-[a-z0-9-]+'",
  }),
  owner: z.string().min(1),
  status: RunStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  microvmId: z.string().optional(),
  endpoint: z.string().optional(),
  imageVersion: z.string().min(1),
  repo: z.object({
    url: z.string().min(1),
    ref: z.string().optional(),
    workBranch: z.string().min(1),
  }),
  model: z.object({
    provider: z.string().min(1),
    id: z.string().min(1),
  }),
  lastEntryId: z.string().optional(),
  usage: ManifestUsageSchema.optional(),
  git: ManifestGitSchema.optional(),
  error: ProtocolErrorSchema.optional(),
  continuedFrom: z.string().optional(),
  timeline: z.array(TimelineEntrySchema),
});

export type RunManifest = z.infer<typeof RunManifestSchema>;

/**
 * RunnerStatus schema (v1).
 * Returned by GET /v1/status.
 */
export const RunnerStatusSchema = z.object({
  status: z.string().min(1),
  runId: z.string().min(1),
  uptimeSeconds: z.number().nonnegative(),
  activeConnections: z.number().int().nonnegative(),
  lastActivityAt: z.string().datetime(),
  pi: z.object({
    running: z.boolean(),
    pid: z.number().int().positive().optional(),
    currentSessionId: z.string().optional(),
    lastEventAt: z.string().datetime().optional(),
  }),
});

export type RunnerStatus = z.infer<typeof RunnerStatusSchema>;

/**
 * Server-Sent Events (SSE) event envelope.
 */
export const SseEnvelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  data: z.unknown(),
});

export type SseEnvelope = z.infer<typeof SseEnvelopeSchema>;

/**
 * Asserts that a serialized LaunchPayload fits within the MicroVM run-hook size budget.
 * Throws a descriptive error if the payload exceeds maxBytes.
 */
export function assertPayloadFits(
  payload: LaunchPayload,
  maxBytes: number = MAX_LAUNCH_PAYLOAD_BYTES,
): void {
  const json = JSON.stringify(payload);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > maxBytes) {
    throw new Error(
      `LaunchPayload size (${byteLength} bytes) exceeds maximum allowable budget of ${maxBytes} bytes`,
    );
  }
}

/**
 * Validates and encodes a LaunchPayload into a JSON string, enforcing size constraints.
 */
export function encodeLaunchPayload(
  payload: LaunchPayload,
  maxBytes: number = MAX_LAUNCH_PAYLOAD_BYTES,
): string {
  const validated = LaunchPayloadSchema.parse(payload);
  assertPayloadFits(validated, maxBytes);
  return JSON.stringify(validated);
}

/**
 * Parses and validates a raw JSON string into a LaunchPayload.
 */
export function decodeLaunchPayload(raw: string): LaunchPayload {
  const parsed = JSON.parse(raw);
  return LaunchPayloadSchema.parse(parsed);
}

/**
 * Validates and encodes a RunManifest into a JSON string.
 */
export function encodeRunManifest(manifest: RunManifest): string {
  const validated = RunManifestSchema.parse(manifest);
  return JSON.stringify(validated, null, 2);
}

/**
 * Parses and validates a raw JSON string into a RunManifest.
 */
export function decodeRunManifest(raw: string): RunManifest {
  const parsed = JSON.parse(raw);
  return RunManifestSchema.parse(parsed);
}

/**
 * Validates and encodes a RunnerStatus into a JSON string.
 */
export function encodeRunnerStatus(status: RunnerStatus): string {
  const validated = RunnerStatusSchema.parse(status);
  return JSON.stringify(validated, null, 2);
}

/**
 * Parses and validates a raw JSON string into a RunnerStatus.
 */
export function decodeRunnerStatus(raw: string): RunnerStatus {
  const parsed = JSON.parse(raw);
  return RunnerStatusSchema.parse(parsed);
}

/**
 * Prompt request schema for POST /v1/prompt.
 * Supports standard prompt, steer (interrupt current turn with direction), and followUp (queue next message).
 */
export const PromptRequestSchema = z
  .object({
    prompt: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
    mode: z.enum(["prompt", "steer", "followUp", "follow_up"]).default("prompt"),
    steer: z.boolean().optional(),
  })
  .refine(
    (data) =>
      Boolean((data.prompt && data.prompt.length > 0) || (data.message && data.message.length > 0)),
    {
      message: "Either 'prompt' or 'message' must be provided",
    },
  );

export type PromptRequest = z.input<typeof PromptRequestSchema>;
export type PromptRequestOutput = z.output<typeof PromptRequestSchema>;

/**
 * Interrupt / abort request schema for POST /v1/interrupt and POST /v1/abort.
 */
export const InterruptRequestSchema = z.object({
  reason: z.string().min(1).optional(),
});

export type InterruptRequest = z.infer<typeof InterruptRequestSchema>;

/**
 * Finalize request schema for POST /v1/finalize.
 */
export const FinalizeRequestSchema = z.object({
  autoPush: z.boolean().optional(),
  commitMessage: z.string().min(1).optional(),
});

export type FinalizeRequest = z.infer<typeof FinalizeRequestSchema>;

/**
 * Standard HTTP headers used by the Lambda MicroVM proxy and runner.
 */
export const ProtocolHeaders = {
  PROXY_AUTH: "x-aws-proxy-auth",
  PROXY_PORT: "x-aws-proxy-port",
  LAST_EVENT_ID: "last-event-id",
} as const;

/**
 * Documented API route registry for runner and lifecycle contracts.
 */
export const PROTOCOL_ROUTES = [
  { method: "GET", path: "/healthz", port: 8080, description: "Liveness probe" },
  { method: "GET", path: "/v1/status", port: 8080, description: "Runner status and agent health" },
  { method: "GET", path: "/v1/manifest", port: 8080, description: "Current run manifest" },
  {
    method: "GET",
    path: "/v1/entries",
    port: 8080,
    description: "Retrieve historical session entries since cursor",
  },
  { method: "GET", path: "/v1/events", port: 8080, description: "Server-Sent Events stream" },
  {
    method: "GET",
    path: "/v1/metrics",
    port: 8080,
    description: "Detailed runner metrics and resource time series",
  },
  {
    method: "POST",
    path: "/v1/prompt",
    port: 8080,
    description: "Send user prompt, steer, or follow-up",
  },
  { method: "POST", path: "/v1/interrupt", port: 8080, description: "Interrupt active agent turn" },
  {
    method: "POST",
    path: "/v1/abort",
    port: 8080,
    description: "Abort current queue and agent turn",
  },
  {
    method: "POST",
    path: "/v1/checkpoint",
    port: 8080,
    description: "Flush session buffer and persist manifest checkpoint",
  },
  {
    method: "POST",
    path: "/v1/finalize",
    port: 8080,
    description: "Finalize run, commit/push, and flush manifest",
  },
  {
    method: "POST",
    path: "/v1/shutdown",
    port: 8080,
    description: "Initiate graceful runner and agent shutdown",
  },
  {
    method: "GET",
    path: "/ws/rpc",
    port: 8080,
    description: "WebSocket LF-delimited JSONL RPC passthrough",
  },
  {
    method: "GET",
    path: "/v1/rpc",
    port: 8080,
    description: "WebSocket LF-delimited JSONL RPC passthrough (alias)",
  },
  {
    method: "GET",
    path: "/aws/lambda-microvms/runtime/v1/ready",
    port: 9000,
    description: "MicroVM ready lifecycle hook",
  },
  {
    method: "POST",
    path: "/aws/lambda-microvms/runtime/v1/validate",
    port: 9000,
    description: "MicroVM validate lifecycle hook",
  },
  {
    method: "POST",
    path: "/aws/lambda-microvms/runtime/v1/run",
    port: 9000,
    description: "MicroVM run launch hook",
  },
  {
    method: "POST",
    path: "/aws/lambda-microvms/runtime/v1/resume",
    port: 9000,
    description: "MicroVM resume from suspend hook",
  },
  {
    method: "POST",
    path: "/aws/lambda-microvms/runtime/v1/suspend",
    port: 9000,
    description: "MicroVM suspend hook",
  },
  {
    method: "POST",
    path: "/aws/lambda-microvms/runtime/v1/terminate",
    port: 9000,
    description: "MicroVM terminate hook",
  },
] as const;
