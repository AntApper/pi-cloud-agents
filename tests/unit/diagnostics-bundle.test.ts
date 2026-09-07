/**
 * Unit tests for Diagnostics Bundle Exporter (T5.6).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { GetMicrovmCommand, LambdaMicrovmsClient } from "@aws-sdk/client-lambda-microvms";
import { GetObjectCommand, type GetObjectCommandOutput, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDiagnosticsBundle } from "../../core/diagnostics-bundle.js";

const s3Mock = mockClient(S3Client);
const microvmsMock = mockClient(LambdaMicrovmsClient);
const cwMock = mockClient(CloudWatchLogsClient);

describe("T5.6 Observability and Diagnostics Bundle", () => {
  let tmpDir: string;

  beforeEach(() => {
    s3Mock.reset();
    microvmsMock.reset();
    cwMock.reset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cloud-diag-test-"));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("gathers manifest, microvm info, and logs, sanitizing secrets and account IDs", async () => {
    const mockManifest = {
      v: 1,
      runId: "run-20260906-diag001",
      owner: "user-123456789012",
      status: "completed",
      createdAt: "2026-09-06T12:00:00Z",
      updatedAt: "2026-09-06T12:30:00Z",
      microvmId: "mvm-0123456789abcdef0",
      imageVersion: "1.0",
      repo: {
        url: "https://github.com/acme/api.git",
        workBranch: "pi-cloud/diag001",
      },
      model: {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
      },
      timeline: [],
    };

    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToString: async () => JSON.stringify(mockManifest),
      } as unknown as GetObjectCommandOutput["Body"],
    });

    microvmsMock.on(GetMicrovmCommand).resolves({
      state: "TERMINATED",
      endpoint: "mvm-0123.microvm.us-east-1.amazonaws.com",
      imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:runner",
      imageVersion: "1.0",
    });

    cwMock.on(FilterLogEventsCommand).resolves({
      events: [
        { message: "Starting runner in account 123456789012" },
        { message: "Execution finished with status 0" },
      ],
    });

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

    const { bundle, bundleFilePath } = await createDiagnosticsBundle({
      runId: "run-20260906-diag001",
      config: mockConfig,
      s3Client: s3Mock as unknown as S3Client,
      microvmsClient: microvmsMock as unknown as LambdaMicrovmsClient,
      cwClient: cwMock as unknown as CloudWatchLogsClient,
      outputDir: tmpDir,
    });

    expect(bundle.runId).toBe("run-20260906-diag001");
    expect(bundle.logLines).toHaveLength(2);
    expect(fs.existsSync(bundleFilePath)).toBe(true);

    const fileContent = fs.readFileSync(bundleFilePath, "utf-8");
    // Verify account number is redacted
    expect(fileContent).not.toContain("123456789012");
    expect(fileContent).toContain("<ACCOUNT_ID>");
  });
});
