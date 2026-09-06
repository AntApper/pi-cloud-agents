import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
} from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import {
  GetMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ListManagedMicrovmImageVersionsCommand,
  ListManagedMicrovmImagesCommand,
} from "@aws-sdk/client-lambda-microvms";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  CreateSecretCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AwsClientFactory } from "../../core/aws/clients.js";
import {
  executeSetup,
  getStepLedgerPath,
  loadStepLedger,
  recordLedgerStep,
} from "../../core/setup/run.js";
import type { LocalConfig } from "../../shared/config.js";

const cfnMock = mockClient(CloudFormationClient);
const s3Mock = mockClient(S3Client);
const microvmsMock = mockClient(LambdaMicrovmsClient);
const secretsMock = mockClient(SecretsManagerClient);
const cwMock = mockClient(CloudWatchLogsClient);

describe("Setup Execution Engine (T4.3b)", () => {
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
      maxConcurrent: 3,
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
    secretsMock.reset();
    cwMock.reset();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-setup-run-test-"));
    clientFactory = new AwsClientFactory({ region: "us-east-1", profile: "test-profile" });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("executes full setup workflow from scratch (all 8 steps) successfully", async () => {
    // 1. Core Stack Mock
    cfnMock
      .on(DescribeStacksCommand, { StackName: "pi-cloud-agents-test" })
      .rejectsOnce({ name: "ValidationError", message: "Stack does not exist" })
      .resolves({
        Stacks: [
          {
            StackName: "pi-cloud-agents-test",
            CreationTime: new Date(),
            StackStatus: "CREATE_COMPLETE",
            Outputs: [
              { OutputKey: "BucketName", OutputValue: "test-pi-artifact-bucket-12345" },
              { OutputKey: "StorageBucketName", OutputValue: "test-pi-artifact-bucket-12345" },
              {
                OutputKey: "BuildRoleArn",
                OutputValue: "arn:aws:iam::123456789012:role/BuildRole",
              },
              {
                OutputKey: "ExecutionRoleArn",
                OutputValue: "arn:aws:iam::123456789012:role/ExecutionRole",
              },
              {
                OutputKey: "ImageLogGroup",
                OutputValue: "/aws/lambda/microvms/pi-cloud-agents-runner-test",
              },
            ],
          },
        ],
      });

    cfnMock.on(CreateChangeSetCommand).resolves({ Id: "cs-123" });
    cfnMock.on(DescribeChangeSetCommand).resolves({ Status: "CREATE_COMPLETE" });
    cfnMock.on(ExecuteChangeSetCommand).resolves({});
    cfnMock.on(DescribeStackEventsCommand).resolves({ StackEvents: [] });

    // 2. Artifacts Mock
    s3Mock.on(HeadObjectCommand).rejects({ name: "NotFound", $metadata: { httpStatusCode: 404 } });
    s3Mock.on(PutObjectCommand).resolves({});

    // 3. Image Stack Mock
    microvmsMock.on(ListManagedMicrovmImagesCommand).resolves({
      items: [
        {
          imageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-minimal",
          createdAt: new Date(),
        },
      ],
    });
    microvmsMock.on(ListManagedMicrovmImageVersionsCommand).resolves({
      items: [
        {
          imageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-minimal",
          imageVersion: "1.0.0",
          status: "AVAILABLE",
          createdAt: new Date(),
        },
      ],
    });

    cfnMock
      .on(DescribeStacksCommand, { StackName: "pi-cloud-agents-test-image" })
      .rejectsOnce({ name: "ValidationError", message: "Stack does not exist" })
      .resolves({
        Stacks: [
          {
            StackName: "pi-cloud-agents-test-image",
            CreationTime: new Date(),
            StackStatus: "CREATE_COMPLETE",
            Outputs: [
              {
                OutputKey: "ImageArn",
                OutputValue:
                  "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner-test",
              },
              { OutputKey: "LatestActiveImageVersion", OutputValue: "1" },
              {
                OutputKey: "ControllerFunctionName",
                OutputValue: "pi-cloud-agents-test-controller",
              },
            ],
          },
        ],
      });

    // 4. Image Ready Wait Mock
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

    // 5. Secrets Mock
    secretsMock.on(CreateSecretCommand).resolves({
      ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:test",
      VersionId: "v1",
    });
    secretsMock.on(PutSecretValueCommand).resolves({
      ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:test",
      VersionId: "v2",
    });

    // Create dummy artifact files in tmpDir
    const dummyRunnerZip = path.join(tmpDir, "app.zip");
    const dummyControllerZip = path.join(tmpDir, "controller.zip");
    fs.writeFileSync(dummyRunnerZip, "PK dummy zip runner");
    fs.writeFileSync(dummyControllerZip, "PK dummy zip controller");

    const result = await executeSetup({
      config: mockConfig,
      clientFactory,
      piAgentDir: tmpDir,
      runnerZipPath: dummyRunnerZip,
      controllerZipPath: dummyControllerZip,
      githubToken: "github_pat_1234567890abcdef",
      authEntries: {
        anthropic: { type: "api_key", key: "sk-ant-12345" },
        openai: { type: "api_key", key: "sk-proj-67890" },
      },
    });

    expect(result.success).toBe(true);
    expect(result.bucketName).toBe("test-pi-artifact-bucket-12345");
    expect(result.imageArn).toBe(
      "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner-test",
    );
    expect(result.completedSteps).toEqual([
      "ensure_core_stack",
      "upload_artifacts",
      "deploy_image_stack",
      "wait_image_ready",
      "sync_bundle_and_secrets",
      "store_github_token",
      "write_config",
      "verify_health",
    ]);
    expect(result.skippedSteps).toEqual([]);

    // Check config saved
    const configPath = path.join(tmpDir, "pi-cloud-agents.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const savedConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(savedConfig.stackName).toBe("pi-cloud-agents-test");

    // Ledger should be cleared on success
    const ledgerPath = getStepLedgerPath(undefined, tmpDir);
    expect(fs.existsSync(ledgerPath)).toBe(false);
  });

  it("resumes from existing ledger skipping already completed steps", async () => {
    const ledgerPath = getStepLedgerPath(undefined, tmpDir);

    // Pre-populate ledger with steps 1 and 2 completed
    recordLedgerStep(ledgerPath, "pi-cloud-agents-test", "us-east-1", "ensure_core_stack", {
      bucketName: "resumed-bucket-123",
      buildRoleArn: "arn:aws:iam::123:role/Build",
      executionRoleArn: "arn:aws:iam::123:role/Exec",
      imageLogGroup: "/aws/lambda/microvms/test",
    });
    recordLedgerStep(ledgerPath, "pi-cloud-agents-test", "us-east-1", "upload_artifacts", {
      runnerKey: "runner/cached-sha.zip",
      controllerKey: "controller/cached-sha.zip",
    });

    // Mock image stack and onward
    microvmsMock.on(ListManagedMicrovmImagesCommand).resolves({
      items: [
        {
          imageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-minimal",
          createdAt: new Date(),
        },
      ],
    });
    microvmsMock.on(ListManagedMicrovmImageVersionsCommand).resolves({
      items: [
        {
          imageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-minimal",
          imageVersion: "1.0.0",
          status: "AVAILABLE",
          createdAt: new Date(),
        },
      ],
    });

    cfnMock.on(DescribeStacksCommand, { StackName: "pi-cloud-agents-test" }).resolves({
      Stacks: [
        {
          StackName: "pi-cloud-agents-test",
          CreationTime: new Date(),
          StackStatus: "CREATE_COMPLETE",
          Outputs: [
            { OutputKey: "StorageBucketName", OutputValue: "resumed-bucket-123" },
            { OutputKey: "BucketName", OutputValue: "resumed-bucket-123" },
          ],
        },
      ],
    });

    cfnMock
      .on(DescribeStacksCommand, { StackName: "pi-cloud-agents-test-image" })
      .rejectsOnce({ name: "ValidationError", message: "Stack does not exist" })
      .resolves({
        Stacks: [
          {
            StackName: "pi-cloud-agents-test-image",
            CreationTime: new Date(),
            StackStatus: "CREATE_COMPLETE",
            Outputs: [
              {
                OutputKey: "ImageArn",
                OutputValue: "arn:aws:lambda:us-east-1:123:microvm-image:resumed",
              },
              { OutputKey: "LatestActiveImageVersion", OutputValue: "1" },
            ],
          },
        ],
      });

    cfnMock.on(CreateChangeSetCommand).resolves({ Id: "cs-456" });
    cfnMock.on(DescribeChangeSetCommand).resolves({ Status: "CREATE_COMPLETE" });
    cfnMock.on(ExecuteChangeSetCommand).resolves({});
    cfnMock.on(DescribeStackEventsCommand).resolves({ StackEvents: [] });

    microvmsMock.on(GetMicrovmImageCommand).resolves({
      imageArn: "arn:aws:lambda:us-east-1:123:microvm-image:resumed",
      state: "CREATED",
      latestActiveImageVersion: "1",
    });
    microvmsMock.on(GetMicrovmImageVersionCommand).resolves({
      imageVersion: "1",
      state: "SUCCESSFUL",
      status: "ACTIVE",
    });

    s3Mock.on(PutObjectCommand).resolves({});
    secretsMock.on(CreateSecretCommand).resolves({});

    const result = await executeSetup({
      config: mockConfig,
      clientFactory,
      piAgentDir: tmpDir,
      authEntries: {
        anthropic: { type: "api_key", key: "sk-ant-test" },
      },
    });

    expect(result.success).toBe(true);
    expect(result.skippedSteps).toContain("ensure_core_stack");
    expect(result.skippedSteps).toContain("upload_artifacts");
    expect(result.completedSteps).toContain("deploy_image_stack");
    expect(result.completedSteps).toContain("wait_image_ready");
    expect(result.completedSteps).toContain("sync_bundle_and_secrets");
  });

  it("handles dry-run mode without executing AWS changes", async () => {
    const result = await executeSetup({
      config: mockConfig,
      clientFactory,
      piAgentDir: tmpDir,
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.completedSteps).toEqual([]);
    expect(result.skippedSteps.length).toBe(8);
  });

  it("captures deployment failures, records partial ledger, and returns actionable MappedAwsError", async () => {
    cfnMock
      .on(DescribeStacksCommand, { StackName: "pi-cloud-agents-test" })
      .rejectsOnce({ name: "ValidationError", message: "Stack does not exist" });

    cfnMock.on(CreateChangeSetCommand).rejects({
      name: "AccessDeniedException",
      message: "User is not authorized to perform: cloudformation:CreateChangeSet",
    });

    const result = await executeSetup({
      config: mockConfig,
      clientFactory,
      piAgentDir: tmpDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.message).toMatch(/Access denied/i);

    const ledger = loadStepLedger(getStepLedgerPath(undefined, tmpDir));
    expect(ledger?.completedSteps ?? []).not.toContain("ensure_core_stack");
  });
});
