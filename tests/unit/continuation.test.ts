/**
 * Unit tests for Multi-turn Run Continuation across 8-hour limit (T5.3).
 */

import {
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { continueCloudRun } from "../../core/continuation.js";
import * as launcherModule from "../../core/launcher.js";
import type { RunManifest } from "../../shared/protocol.js";

const s3Mock = mockClient(S3Client);

describe("T5.3 Multi-turn Run Continuation", () => {
  beforeEach(() => {
    s3Mock.reset();
  });

  it("fetches prior manifest, launches continuation MicroVM, and updates continuedFrom link", async () => {
    const priorManifest: RunManifest = {
      v: 1,
      runId: "run-prior-001",
      owner: "user-ant",
      status: "completed",
      createdAt: "2026-09-06T10:00:00Z",
      updatedAt: "2026-09-06T18:00:00Z",
      imageVersion: "1.0",
      repo: {
        url: "https://github.com/acme/api.git",
        workBranch: "pi-cloud/run-prior-001",
      },
      model: {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
      },
      timeline: [],
    };

    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToString: async () => JSON.stringify(priorManifest),
      } as unknown as GetObjectCommandOutput["Body"],
    });
    s3Mock.on(PutObjectCommand).resolves({});

    const mockLaunchResult = {
      runId: "run-new-002",
      microvmId: "mvm-new-002",
      endpoint: "https://mvm-2.lambda-microvm.us-east-1.amazonaws.com",
      workBranch: "pi-cloud/run-prior-001",
      warnings: [],
      manifest: {
        ...priorManifest,
        runId: "run-new-002",
        status: "running" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };

    vi.spyOn(launcherModule, "launchCloudRun").mockResolvedValue(mockLaunchResult);

    const mockConfig = {
      aws: { region: "us-east-1" },
      stackName: "pi-cloud-agents-core",
      image: { name: "pi-cloud-agents-runner", memoryMiB: 4096 },
      defaults: {
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        maxDurationHours: 4,
        idle: { suspendAfterMin: 15, terminateAfterSuspendedMin: 120 },
        maxConcurrent: 3,
        archiveRetentionDays: 30,
        controllerCadenceMin: 1,
      },
      providers: { synced: ["anthropic"], oauthOptIn: [], bedrockRole: false },
      github: { mode: "none" as const },
    };

    const result = await continueCloudRun({
      priorRunId: "run-prior-001",
      config: mockConfig,
      s3Client: s3Mock as unknown as S3Client,
    });

    expect(result.newRunId).toBe("run-new-002");
    expect(result.priorRunId).toBe("run-prior-001");
    expect(result.workBranch).toBe("pi-cloud/run-prior-001");
    expect(result.manifest.continuedFrom).toBe("run-prior-001");
  });
});
