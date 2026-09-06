import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  GetMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
} from "@aws-sdk/client-lambda-microvms";
import {
  GetBucketEncryptionCommand,
  GetPublicAccessBlockCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { DescribeSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AwsClientFactory } from "../../core/aws/clients.js";
import { formatVerifyReport, runVerification } from "../../core/verify/engine.js";
import { handleCloudVerifyCommand } from "../../extension/commands/verify.js";
import type { LocalConfig } from "../../shared/config.js";

const stsMock = mockClient(STSClient);
const cfnMock = mockClient(CloudFormationClient);
const s3Mock = mockClient(S3Client);
const microvmsMock = mockClient(LambdaMicrovmsClient);
const secretsMock = mockClient(SecretsManagerClient);

describe("Verification Engine (T4.3d)", () => {
  let tmpDir: string;
  let clientFactory: AwsClientFactory;

  const validConfig: LocalConfig = {
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
    stsMock.reset();
    cfnMock.reset();
    s3Mock.reset();
    microvmsMock.reset();
    secretsMock.reset();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-verify-test-"));
    clientFactory = new AwsClientFactory({ region: "us-east-1", profile: "test-profile" });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("runs all static checks, smoke run, and model check with green verdict", async () => {
    // 1. STS Identity
    stsMock.on(GetCallerIdentityCommand).resolves({
      Account: "123456789012",
      Arn: "arn:aws:iam::123456789012:user/ant",
      UserId: "AIDA1234567890",
    });

    // 2. CFN Stacks
    cfnMock.on(DescribeStacksCommand, { StackName: "pi-cloud-agents-test" }).resolves({
      Stacks: [
        {
          StackName: "pi-cloud-agents-test",
          CreationTime: new Date(),
          StackStatus: "CREATE_COMPLETE",
          Outputs: [
            { OutputKey: "BucketName", OutputValue: "pi-cloud-agents-test-bucket" },
            { OutputKey: "StorageBucketName", OutputValue: "pi-cloud-agents-test-bucket" },
          ],
        },
      ],
    });

    cfnMock.on(DescribeStacksCommand, { StackName: "pi-cloud-agents-test-image" }).resolves({
      Stacks: [
        {
          StackName: "pi-cloud-agents-test-image",
          CreationTime: new Date(),
          StackStatus: "CREATE_COMPLETE",
        },
      ],
    });

    // 3. S3 Bucket
    s3Mock.on(GetBucketEncryptionCommand).resolves({
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
      },
    });
    s3Mock.on(GetPublicAccessBlockCommand).resolves({
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
      },
    });
    s3Mock.on(HeadObjectCommand).resolves({
      LastModified: new Date(Date.now() - 30_000), // 30s ago
    });

    // 4. MicroVM Image
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

    // 5. Secrets Manager
    secretsMock.on(DescribeSecretCommand).resolves({
      Name: "pi-cloud-agents/pi-cloud-agents-test/pi-auth/anthropic",
    });

    const report = await runVerification({
      config: validConfig,
      clientFactory,
      piAgentDir: tmpDir,
      withModel: true,
      runSmoke: true,
      simulateSmoke: true,
    });

    expect(report.verdict).toBe("PASS");
    expect(report.region).toBe("us-east-1");
    expect(report.checks.length).toBeGreaterThanOrEqual(10);
    expect(report.checks.every((c) => c.status === "PASS")).toBe(true);

    const formatted = formatVerifyReport(report);
    expect(formatted).toContain("pi cloud agents · Verification Report");
    expect(formatted).toContain("AWS Identity");
    expect(formatted).toContain("CloudFormation Stacks");
    expect(formatted).toContain("MicroVM Runner Image");
    expect(formatted).toContain("Model Connectivity");
    expect(formatted).toContain("Verdict: All");
  });

  it("identifies missing identity and resources with actionable remediations", async () => {
    stsMock.on(GetCallerIdentityCommand).rejects({
      name: "ExpiredToken",
      message: "The security token included in the request is expired",
    });

    cfnMock.on(DescribeStacksCommand).rejects({
      name: "ValidationError",
      message: "Stack with id pi-cloud-agents-test does not exist",
    });

    secretsMock.on(DescribeSecretCommand).rejects({
      name: "ResourceNotFoundException",
      message: "Secrets Manager can't find the specified secret",
    });

    const report = await runVerification({
      config: validConfig,
      clientFactory,
      piAgentDir: tmpDir,
    });

    expect(report.verdict).toBe("FAIL");
    const failedChecks = report.checks.filter((c) => c.status === "FAIL");
    expect(failedChecks.length).toBeGreaterThan(0);

    const idFail = report.checks.find((c) => c.id === "aws_identity");
    expect(idFail?.status).toBe("FAIL");
    expect(idFail?.remediation).toBeDefined();

    const formatted = formatVerifyReport(report);
    expect(formatted).toContain("Remediations:");
    expect(formatted).toContain("Verdict: Verification failed");
  });

  it("executes /cloud verify extension command handler", async () => {
    stsMock.on(GetCallerIdentityCommand).resolves({
      Account: "123456789012",
      Arn: "arn:aws:iam::123456789012:user/ant",
    });

    const notified: Array<{ message: string; type?: string }> = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify: (message: string, type?: string) => {
          notified.push({ message, type });
        },
      },
    };

    const result = await handleCloudVerifyCommand(
      ["--no-model"],
      ctx as unknown as import("../../extension/router.js").RouteContext,
    );
    expect(result.handled).toBe(true);
    expect(result.subcommand).toBe("verify");
    expect(result.output).toContain("Verification Report");
    expect(notified.length).toBeGreaterThan(0);
  });
});
