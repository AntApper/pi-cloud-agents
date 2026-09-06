import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSchemas } from "../../scripts/gen-schemas.js";
import {
  ErrorResponseSchema,
  type LaunchPayload,
  LaunchPayloadSchema,
  MAX_LAUNCH_PAYLOAD_BYTES,
  ProtocolErrorCode,
  type RunManifest,
  RunManifestSchema,
  type RunnerStatus,
  RunnerStatusSchema,
  SseEnvelopeSchema,
  assertPayloadFits,
  decodeLaunchPayload,
  decodeRunManifest,
  decodeRunnerStatus,
  encodeLaunchPayload,
  encodeRunManifest,
  encodeRunnerStatus,
} from "../../shared/protocol.js";

const sampleLaunchPayload: LaunchPayload = {
  v: 1,
  runId: "run-test-123456",
  owner: "arn:aws:iam::123456789012:user/alice",
  stack: {
    name: "pi-cloud-agents-core",
    region: "us-east-1",
    bucket: "pi-cloud-agents-core-runs-123456789012",
    prefix: "runs",
  },
  repo: {
    url: "https://github.com/example/repo.git",
    ref: "main",
    workBranch: "pi-cloud/run-test-123456",
    depth: 1,
  },
  model: {
    provider: "anthropic",
    id: "claude-sonnet-4-20250514",
    thinking: {
      budgetTokens: 2048,
    },
  },
  piConfig: {
    bundleKey: "config/alice/bundle.tar",
    authParams: ["anthropic", "github"],
    bedrockRole: false,
  },
  github: {
    mode: "secret",
    name: "pi-cloud-agents/pi-cloud-agents-core/github/token",
  },
  options: {
    installTimeoutSec: 300,
    trustProjectConfig: true,
    idleGraceSec: 60,
    suspendAfterIdleSec: 300,
    terminateAfterSuspendedSec: 7200,
    autoPush: true,
    maxDurationSec: 14400,
  },
  logGroup: "/aws/lambda/microvms/pi-cloud-agents-runner",
};

const sampleManifest: RunManifest = {
  v: 1,
  runId: "run-test-123456",
  owner: "arn:aws:iam::123456789012:user/alice",
  status: "running",
  createdAt: "2026-09-06T12:00:00.000Z",
  updatedAt: "2026-09-06T12:05:00.000Z",
  microvmId: "microvm-abc123def456",
  endpoint: "https://microvm-abc123def456.lambda-microvms.us-east-1.amazonaws.com",
  imageVersion: "1.0",
  repo: {
    url: "https://github.com/example/repo.git",
    ref: "main",
    workBranch: "pi-cloud/run-test-123456",
  },
  model: {
    provider: "anthropic",
    id: "claude-sonnet-4-20250514",
  },
  lastEntryId: "entry-001",
  usage: {
    inputTokens: 1250,
    outputTokens: 420,
    totalTokens: 1670,
    estimatedCostUsd: 0.0125,
  },
  git: {
    workBranch: "pi-cloud/run-test-123456",
    lastCommit: "abcdef1234567890",
    prUrl: "https://github.com/example/repo/pull/1",
  },
  timeline: [
    {
      status: "launching",
      at: "2026-09-06T12:00:00.000Z",
      reason: "RunMicrovm initiated",
    },
    {
      status: "running",
      at: "2026-09-06T12:00:15.000Z",
      reason: "Runner ready",
    },
  ],
};

const sampleRunnerStatus: RunnerStatus = {
  status: "ready",
  runId: "run-test-123456",
  uptimeSeconds: 120,
  activeConnections: 1,
  lastActivityAt: "2026-09-06T12:05:00.000Z",
  pi: {
    running: true,
    pid: 1234,
    currentSessionId: "session-abc-123",
    lastEventAt: "2026-09-06T12:04:55.000Z",
  },
};

describe("LaunchPayload schema and encoding", () => {
  it("validates and round-trips a valid LaunchPayload", () => {
    const encoded = encodeLaunchPayload(sampleLaunchPayload);
    const decoded = decodeLaunchPayload(encoded);
    expect(decoded).toEqual(sampleLaunchPayload);
  });

  it("supports boolean thinking option", () => {
    const payloadWithBoolThinking: LaunchPayload = {
      ...sampleLaunchPayload,
      model: {
        ...sampleLaunchPayload.model,
        thinking: true,
      },
    };
    const encoded = encodeLaunchPayload(payloadWithBoolThinking);
    const decoded = decodeLaunchPayload(encoded);
    expect(decoded.model.thinking).toBe(true);
  });

  it("supports github mode none", () => {
    const payloadGithubNone: LaunchPayload = {
      ...sampleLaunchPayload,
      github: { mode: "none" },
    };
    const encoded = encodeLaunchPayload(payloadGithubNone);
    const decoded = decodeLaunchPayload(encoded);
    expect(decoded.github).toEqual({ mode: "none" });
  });

  it("rejects invalid versions (e.g. v: 2 or v: 0)", () => {
    const invalidVersion = { ...sampleLaunchPayload, v: 2 };
    expect(() => LaunchPayloadSchema.parse(invalidVersion)).toThrow();
  });

  it("rejects invalid runId formats", () => {
    expect(() =>
      LaunchPayloadSchema.parse({
        ...sampleLaunchPayload,
        runId: "invalid_id_format",
      }),
    ).toThrow();

    expect(() =>
      LaunchPayloadSchema.parse({
        ...sampleLaunchPayload,
        runId: "RUN-123",
      }),
    ).toThrow();
  });

  it("rejects maxDurationSec exceeding 8 hours (28,800 seconds)", () => {
    expect(() =>
      LaunchPayloadSchema.parse({
        ...sampleLaunchPayload,
        options: {
          ...sampleLaunchPayload.options,
          maxDurationSec: 28801,
        },
      }),
    ).toThrow();
  });

  it("enforces 3.5 KB size budget on valid payloads", () => {
    expect(() => assertPayloadFits(sampleLaunchPayload)).not.toThrow();
    const encoded = encodeLaunchPayload(sampleLaunchPayload);
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_LAUNCH_PAYLOAD_BYTES);
  });

  it("rejects payloads exceeding the 3.5 KB budget", () => {
    const hugePayload: LaunchPayload = {
      ...sampleLaunchPayload,
      owner: "a".repeat(4000),
    };

    expect(() => assertPayloadFits(hugePayload)).toThrow(/exceeds maximum allowable budget/);
    expect(() => encodeLaunchPayload(hugePayload)).toThrow(/exceeds maximum allowable budget/);
  });
});

describe("RunManifest schema and encoding", () => {
  it("validates and round-trips a valid RunManifest", () => {
    const encoded = encodeRunManifest(sampleManifest);
    const decoded = decodeRunManifest(encoded);
    expect(decoded).toEqual(sampleManifest);
  });

  it("supports error details and continuedFrom links", () => {
    const manifestWithError: RunManifest = {
      ...sampleManifest,
      status: "failed",
      error: {
        code: ProtocolErrorCode.SECRET_MISSING,
        message: "Secret anthropic not found",
        details: { provider: "anthropic" },
      },
      continuedFrom: "run-prev-999999",
    };

    const encoded = encodeRunManifest(manifestWithError);
    const decoded = decodeRunManifest(encoded);
    expect(decoded.status).toBe("failed");
    expect(decoded.error?.code).toBe(ProtocolErrorCode.SECRET_MISSING);
    expect(decoded.continuedFrom).toBe("run-prev-999999");
  });

  it("rejects unknown statuses in manifest", () => {
    const invalidStatus = {
      ...sampleManifest,
      status: "non_existent_status",
    };
    expect(() => RunManifestSchema.parse(invalidStatus)).toThrow();
  });

  it("rejects non-ISO datetime timestamps in manifest", () => {
    const invalidDate = {
      ...sampleManifest,
      createdAt: "not-a-date",
    };
    expect(() => RunManifestSchema.parse(invalidDate)).toThrow();
  });
});

describe("RunnerStatus schema and encoding", () => {
  it("validates and round-trips a valid RunnerStatus", () => {
    const encoded = encodeRunnerStatus(sampleRunnerStatus);
    const decoded = decodeRunnerStatus(encoded);
    expect(decoded).toEqual(sampleRunnerStatus);
  });

  it("rejects negative uptime or connections", () => {
    expect(() =>
      RunnerStatusSchema.parse({
        ...sampleRunnerStatus,
        uptimeSeconds: -10,
      }),
    ).toThrow();

    expect(() =>
      RunnerStatusSchema.parse({
        ...sampleRunnerStatus,
        activeConnections: -1,
      }),
    ).toThrow();
  });
});

describe("SSE Envelope and Error Response schemas", () => {
  it("validates SSE envelopes", () => {
    const envelope = {
      id: "entry-001",
      type: "message_update",
      data: { delta: "Hello world" },
    };
    expect(() => SseEnvelopeSchema.parse(envelope)).not.toThrow();
  });

  it("validates ErrorResponse shapes", () => {
    const errorResponse = {
      error: {
        code: ProtocolErrorCode.PAYLOAD_TOO_LARGE,
        message: "Payload exceeded limit",
        details: { maxBytes: 3584, actualBytes: 4000 },
      },
    };
    expect(() => ErrorResponseSchema.parse(errorResponse)).not.toThrow();
  });
});

describe("JSON Schema generation and drift detection", () => {
  it("generates expected schema files in docs/schemas/", () => {
    const generated = generateSchemas();
    expect(generated.length).toBe(9);

    for (const file of generated) {
      const content = readFileSync(file, "utf8");
      const parsed = JSON.parse(content);
      expect(parsed).toHaveProperty("$schema");
      expect(parsed).toHaveProperty("definitions");
    }
  });
});
