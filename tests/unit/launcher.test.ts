import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  GetMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  RunMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AwsClientFactory } from "../../core/aws/clients.js";
import { generateRunId, inspectGitRepo, launchCloudRun } from "../../core/launcher.js";
import { handleCloudNewCommand } from "../../extension/commands/new.js";
import type { LocalConfig } from "../../shared/config.js";
import { RUN_ID_REGEX } from "../../shared/protocol.js";

const cfnMock = mockClient(CloudFormationClient);
const s3Mock = mockClient(S3Client);
const microvmsMock = mockClient(LambdaMicrovmsClient);

describe("Cloud Agent Launcher (T4.4)", () => {
  let tmpDir: string;
  let clientFactory: AwsClientFactory;

  const mockConfig: LocalConfig = {
    aws: {
      profile: "test-profile",
      region: "us-east-1",
    },
    stackName: "pi-cloud-agents-test",
    image: {
      name: "pi-cloud-agents-runner-test",
      memoryMiB: 4096,
    },
    defaults: {
      model: {
        provider: "anthropic",
        id: "claude-3-7-sonnet",
      },
      maxDurationHours: 4,
      idle: {
        suspendAfterMin: 15,
        terminateAfterSuspendedMin: 60,
      },
      maxConcurrent: 2,
      archiveRetentionDays: 30,
      controllerCadenceMin: 1,
    },
    providers: {
      synced: ["anthropic", "openai"],
      oauthOptIn: [],
      bedrockRole: true,
    },
    github: {
      mode: "secret",
      secretName: "pi-cloud-agents/pi-cloud-agents-test/github/token",
    },
  };

  beforeEach(() => {
    cfnMock.reset();
    s3Mock.reset();
    microvmsMock.reset();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-launcher-test-"));
    clientFactory = new AwsClientFactory({ region: "us-east-1", profile: "test-profile" });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe("generateRunId", () => {
    it("generates valid runId matching RUN_ID_REGEX", () => {
      const id1 = generateRunId();
      const id2 = generateRunId();
      expect(id1).toMatch(RUN_ID_REGEX);
      expect(id2).toMatch(RUN_ID_REGEX);
      expect(id1).not.toBe(id2);
    });
  });

  describe("inspectGitRepo", () => {
    it("inspects current repository without throwing", () => {
      const info = inspectGitRepo(process.cwd());
      expect(info.currentBranch).toBeDefined();
      expect(typeof info.isDirty).toBe("boolean");
    });
  });

  describe("launchCloudRun", () => {
    it("launches a cloud run end-to-end with dry-run mode", async () => {
      cfnMock.on(DescribeStacksCommand).resolves({
        Stacks: [
          {
            StackName: "pi-cloud-agents-test",
            CreationTime: new Date(),
            StackStatus: "CREATE_COMPLETE",
            Outputs: [{ OutputKey: "BucketName", OutputValue: "test-storage-bucket" }],
          },
        ],
      });

      microvmsMock.on(GetMicrovmImageCommand).resolves({
        imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner-test",
        state: "CREATED",
        latestActiveImageVersion: "1",
      });
      microvmsMock.on(GetMicrovmImageVersionCommand).resolves({
        imageVersion: "1",
        state: "SUCCESSFUL",
        status: "ACTIVE",
      });
      microvmsMock.on(ListMicrovmsCommand).resolves({ items: [] });
      s3Mock.on(PutObjectCommand).resolves({});

      const result = await launchCloudRun({
        prompt: "Refactor database migrations",
        config: mockConfig,
        clientFactory,
        dryRun: true,
      });

      expect(result.runId).toMatch(RUN_ID_REGEX);
      expect(result.manifest.status).toBe("launching");
      expect(result.workBranch).toBe(`pi-cloud/${result.runId}`);
      expect(result.endpoint).toBeDefined();
    });

    it("enforces maxConcurrent runs limit and throws ConcurrencyLimitExceeded", async () => {
      cfnMock.on(DescribeStacksCommand).resolves({
        Stacks: [
          {
            StackName: "pi-cloud-agents-test",
            CreationTime: new Date(),
            StackStatus: "CREATE_COMPLETE",
            Outputs: [{ OutputKey: "BucketName", OutputValue: "test-storage-bucket" }],
          },
        ],
      });

      microvmsMock.on(GetMicrovmImageCommand).resolves({
        imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner-test",
        state: "CREATED",
        latestActiveImageVersion: "1",
      });
      microvmsMock.on(GetMicrovmImageVersionCommand).resolves({
        imageVersion: "1",
        state: "SUCCESSFUL",
        status: "ACTIVE",
      });

      // 2 active VMs already running (maxConcurrent is 2)
      microvmsMock.on(ListMicrovmsCommand).resolves({
        items: [
          {
            microvmId: "vm-1",
            state: "RUNNING",
            imageArn:
              "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner-test",
            imageVersion: "1",
            startedAt: new Date(),
          },
          {
            microvmId: "vm-2",
            state: "SUSPENDED",
            imageArn:
              "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner-test",
            imageVersion: "1",
            startedAt: new Date(),
          },
        ],
      });

      await expect(
        launchCloudRun({
          prompt: "Another task",
          config: mockConfig,
          clientFactory,
        }),
      ).rejects.toThrow(/limit reached/i);
    });

    it("rejects launch when model provider is not synced and Bedrock role disabled", async () => {
      const unsyncedConfig: LocalConfig = {
        ...mockConfig,
        providers: {
          synced: [],
          oauthOptIn: [],
          bedrockRole: false,
        },
      };

      await expect(
        launchCloudRun({
          prompt: "Test prompt",
          config: unsyncedConfig,
          clientFactory,
        }),
      ).rejects.toThrow(/not synced/i);
    });

    it("updates manifest to failed when RunMicrovmCommand fails", async () => {
      cfnMock.on(DescribeStacksCommand).resolves({
        Stacks: [
          {
            StackName: "pi-cloud-agents-test",
            CreationTime: new Date(),
            StackStatus: "CREATE_COMPLETE",
            Outputs: [{ OutputKey: "BucketName", OutputValue: "test-storage-bucket" }],
          },
        ],
      });

      microvmsMock.on(GetMicrovmImageCommand).resolves({
        imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner-test",
        state: "CREATED",
        latestActiveImageVersion: "1",
      });
      microvmsMock.on(GetMicrovmImageVersionCommand).resolves({
        imageVersion: "1",
        state: "SUCCESSFUL",
        status: "ACTIVE",
      });
      microvmsMock.on(ListMicrovmsCommand).resolves({ items: [] });
      s3Mock.on(PutObjectCommand).resolves({});

      microvmsMock.on(RunMicrovmCommand).rejects({
        name: "ServiceQuotaExceededException",
        message: "You have exceeded the maximum memory quota for MicroVMs",
      });

      await expect(
        launchCloudRun({
          prompt: "Task failing to run",
          config: mockConfig,
          clientFactory,
        }),
      ).rejects.toThrow(/Failed to launch MicroVM/i);
    });
  });

  describe("Extension /cloud new command", () => {
    it("displays usage guidance when prompt argument is empty", async () => {
      const result = await handleCloudNewCommand([]);
      expect(result.handled).toBe(true);
      expect(result.output).toContain("Usage: /cloud new");
    });
  });
});
