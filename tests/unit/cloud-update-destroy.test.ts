/**
 * Unit tests for Cloud Update and Cloud Destroy (T4.10).
 * Validates drift detection, image update, version pruning, S3 purge, secret deletion, and stack teardown.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
} from "@aws-sdk/client-cloudformation";
import {
  DeleteMicrovmImageVersionCommand,
  GetMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ListManagedMicrovmImageVersionsCommand,
  ListManagedMicrovmImagesCommand,
  ListMicrovmImageBuildsCommand,
  ListMicrovmImageVersionsCommand,
  ListMicrovmsCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeCloudDestroy, executeCloudUpdate } from "../../core/lifecycle-ops.js";
import {
  handleCloudDestroyCommand,
  handleCloudUpdateCommand,
} from "../../extension/commands/lifecycle-ops.js";
import type { LocalConfig } from "../../shared/config.js";
import { declaredTemplateParameters } from "../fakes/cfn-template.js";

const cfnMock = mockClient(CloudFormationClient);
const s3Mock = mockClient(S3Client);
const microvmsMock = mockClient(LambdaMicrovmsClient);
const secretsMock = mockClient(SecretsManagerClient);

const testRunnerSha = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

// Outputs of a deployed infra/core.yaml stack, as /cloud setup leaves them.
const coreStackOutputs = [
  { OutputKey: "BucketName", OutputValue: "test-bucket" },
  { OutputKey: "StorageBucketName", OutputValue: "test-bucket" },
  { OutputKey: "BuildRoleArn", OutputValue: "arn:aws:iam::123456789012:role/build" },
  { OutputKey: "ExecutionRoleArn", OutputValue: "arn:aws:iam::123456789012:role/exec" },
  { OutputKey: "ImageLogGroup", OutputValue: "/aws/lambda/microvms/pi-cloud-agents-runner-test" },
];

const mockConfig: LocalConfig = {
  aws: {
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
      id: "claude-sonnet-4-5",
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
    synced: ["anthropic"],
    oauthOptIn: [],
    bedrockRole: false,
  },
  github: {
    mode: "none",
  },
};

describe("T4.10 Cloud Update & Destroy", () => {
  let tmpDir: string;
  let tmpRunnerZip: string;

  beforeEach(() => {
    cfnMock.reset();
    s3Mock.reset();
    microvmsMock.reset();
    secretsMock.reset();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cloud-update-test-"));
    tmpRunnerZip = path.join(tmpDir, "app.zip");
    fs.writeFileSync(tmpRunnerZip, "dummy zip content");
    fs.writeFileSync(
      path.join(tmpDir, "manifest.json"),
      JSON.stringify({ sha256: testRunnerSha, piVersion: "0.85.1" }),
    );

    cfnMock.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackName: "pi-cloud-agents-core",
          CreationTime: new Date(),
          StackStatus: "CREATE_COMPLETE",
          Outputs: coreStackOutputs,
        },
        {
          StackName: "pi-cloud-agents-test",
          CreationTime: new Date(),
          StackStatus: "CREATE_COMPLETE",
          Outputs: coreStackOutputs,
        },
      ],
    });

    s3Mock.on(HeadObjectCommand).resolves({
      Metadata: { sha256: testRunnerSha },
    });

    secretsMock.on(CreateSecretCommand).resolves({
      ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:test",
      VersionId: "v1",
    });

    secretsMock.on(PutSecretValueCommand).resolves({
      ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:test",
      VersionId: "v2",
    });

    microvmsMock.on(ListManagedMicrovmImagesCommand).resolves({
      items: [
        {
          imageArn: "arn:aws:lambda:us-east-1::microvm-image:al2023-minimal",
          createdAt: new Date(),
        },
      ],
    });

    microvmsMock.on(ListManagedMicrovmImageVersionsCommand).resolves({
      items: [
        {
          imageArn: "arn:aws:lambda:us-east-1::microvm-image:al2023-minimal",
          imageVersion: "v7",
          createdAt: new Date(),
        },
      ],
    });

    microvmsMock.on(ListMicrovmImageBuildsCommand).resolves({
      items: [],
    });

    cfnMock.on(CreateChangeSetCommand).resolves({ Id: "cs-1" });
    cfnMock.on(DescribeChangeSetCommand).resolves({
      Status: "CREATE_COMPLETE",
      ExecutionStatus: "AVAILABLE",
    });
    cfnMock.on(ExecuteChangeSetCommand).resolves({});
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("executeCloudUpdate", () => {
    it("detects no drift and returns updated=false when image is current", async () => {
      // Mock active image matching manifest sha
      microvmsMock.on(GetMicrovmImageCommand).resolves({
        imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:runner",
        latestActiveImageVersion: "12",
      });

      microvmsMock.on(GetMicrovmImageVersionCommand).resolves({
        imageVersion: "12",
        codeArtifact: { uri: `s3://test-bucket/runner/${testRunnerSha}.zip` },
        environmentVariables: { PI_CLOUD_RUNNER_SHA: testRunnerSha },
        description: JSON.stringify({
          manifestSha256: testRunnerSha,
          piVersion: "0.85.1",
        }),
      });

      s3Mock.on(PutObjectCommand).resolves({});

      const res = await executeCloudUpdate({
        config: mockConfig,
        force: false,
        runnerZipPath: tmpRunnerZip,
      });

      expect(res.updated).toBe(false);
      expect(res.message).toContain("up to date");
    });

    it("executes full update when drift is detected or force is true", async () => {
      // Mock active image with older version
      microvmsMock.on(GetMicrovmImageCommand).resolves({
        imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:runner",
        latestActiveImageVersion: "13",
        state: "CREATED",
      });

      microvmsMock.on(GetMicrovmImageVersionCommand).resolves({
        imageVersion: "12",
        tags: { "pi-cloud-agents:runner-sha": "old-sha" },
        description: JSON.stringify({
          manifestSha256: "old-sha",
          piVersion: "0.80.0",
        }),
      });

      const notFoundErr = new Error("NotFound");
      notFoundErr.name = "NotFound";
      s3Mock.on(HeadObjectCommand).rejects(notFoundErr);
      s3Mock.on(PutObjectCommand).resolves({});

      cfnMock.on(CreateChangeSetCommand).resolves({ Id: "cs-123" });
      cfnMock.on(DescribeChangeSetCommand).resolves({
        Status: "CREATE_COMPLETE",
        ExecutionStatus: "AVAILABLE",
      });
      cfnMock.on(ExecuteChangeSetCommand).resolves({});
      cfnMock.on(DeleteChangeSetCommand).resolves({});

      microvmsMock.on(ListMicrovmImageVersionsCommand).resolves({
        items: [
          {
            imageVersion: "13",
            status: "ACTIVE",
            state: "SUCCESSFUL" as const,
            createdAt: new Date("2026-09-06T12:00:00Z"),
            imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:runner",
            baseImageArn: "arn:aws:lambda:us-east-1::microvm-image:al2023-minimal",
            buildRoleArn: "arn:aws:iam::123456789012:role/build",
            codeArtifact: { uri: "s3://test-bucket/runner/new-sha.zip" },
          },
          {
            imageVersion: "12",
            status: "ACTIVE",
            state: "SUCCESSFUL" as const,
            createdAt: new Date("2026-09-05T12:00:00Z"),
            imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:runner",
            baseImageArn: "arn:aws:lambda:us-east-1::microvm-image:al2023-minimal",
            buildRoleArn: "arn:aws:iam::123456789012:role/build",
            codeArtifact: { uri: "s3://test-bucket/runner/current-sha.zip" },
          },
          {
            imageVersion: "11",
            status: "INACTIVE",
            state: "SUCCESSFUL" as const,
            createdAt: new Date("2026-09-04T12:00:00Z"),
            imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:runner",
            baseImageArn: "arn:aws:lambda:us-east-1::microvm-image:al2023-minimal",
            buildRoleArn: "arn:aws:iam::123456789012:role/build",
            codeArtifact: { uri: "s3://test-bucket/runner/old-sha.zip" },
          },
        ],
      });

      microvmsMock.on(DeleteMicrovmImageVersionCommand).resolves({});

      const res = await executeCloudUpdate({
        config: { ...mockConfig, kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/cmk" },
        force: true,
        runnerZipPath: tmpRunnerZip,
        controllerZipPath: tmpRunnerZip,
      });

      expect(res.updated).toBe(true);
      expect(res.newVersion).toBe("13");
      expect(res.pruneResult?.prunedVersions).toContain("11");

      // The change set must carry exactly the parameters infra/image.yaml declares; CloudFormation
      // rejects unknown keys and missing required ones (T5.11).
      const changeSets = cfnMock.commandCalls(CreateChangeSetCommand);
      expect(changeSets).toHaveLength(1);
      const input = changeSets[0]!.args[0].input;
      expect(input.StackName).toBe("pi-cloud-agents-test-image");
      const parameters = new Map(
        (input.Parameters ?? []).map((p) => [p.ParameterKey ?? "", p.ParameterValue ?? ""]),
      );
      expect([...parameters.keys()].sort()).toEqual(declaredTemplateParameters("image.yaml"));
      expect(parameters.get("ArtifactBucket")).toBe("test-bucket");
      expect(parameters.get("BuildRoleArn")).toBe("arn:aws:iam::123456789012:role/build");
      expect(parameters.get("ExecutionRoleArn")).toBe("arn:aws:iam::123456789012:role/exec");
      expect(parameters.get("ImageLogGroup")).toBe(
        "/aws/lambda/microvms/pi-cloud-agents-runner-test",
      );
      expect(parameters.get("ImageName")).toBe("pi-cloud-agents-runner-test");
      expect(parameters.get("MemoryMiB")).toBe("4096");
      expect(parameters.get("BaseImageArn")).toBe(
        "arn:aws:lambda:us-east-1::microvm-image:al2023-minimal",
      );
      expect(parameters.get("BaseImageVersion")).toBe("v7");
      expect(parameters.get("RunnerArtifactKey")).toMatch(/^runner\//);
      expect(parameters.get("ControllerArtifactKey")).toMatch(/^controller\//);
      expect(parameters.get("KmsKeyArn")).toBe("arn:aws:kms:us-east-1:123456789012:key/cmk");
      expect(input.Tags?.map((t) => t.Key)).toEqual(
        expect.arrayContaining(["pi-cloud-agents:stack", "pi-cloud-agents:managed"]),
      );
    });

    it("fails before uploading anything when the core stack lacks the role outputs", async () => {
      cfnMock.on(DescribeStacksCommand).resolves({
        Stacks: [
          {
            StackName: "pi-cloud-agents-test",
            CreationTime: new Date(),
            StackStatus: "CREATE_COMPLETE",
            Outputs: [{ OutputKey: "BucketName", OutputValue: "test-bucket" }],
          },
        ],
      });
      microvmsMock.on(GetMicrovmImageCommand).resolves({
        imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:runner",
        latestActiveImageVersion: "13",
      });
      microvmsMock.on(GetMicrovmImageVersionCommand).resolves({
        imageVersion: "13",
        description: JSON.stringify({ manifestSha256: "old-sha" }),
      });
      s3Mock.on(PutObjectCommand).resolves({});

      await expect(
        executeCloudUpdate({
          config: mockConfig,
          force: true,
          runnerZipPath: tmpRunnerZip,
          controllerZipPath: tmpRunnerZip,
        }),
      ).rejects.toThrow(/BuildRoleArn\/ExecutionRoleArn.*\/cloud setup/);

      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
      expect(cfnMock.commandCalls(CreateChangeSetCommand)).toHaveLength(0);
    });
  });

  describe("executeCloudDestroy", () => {
    it("terminates VMs, purges S3 bucket, deletes secrets, and tears down CloudFormation stacks", async () => {
      // 1. Active VMs
      microvmsMock.on(ListMicrovmsCommand).resolves({
        items: [
          {
            microvmId: "mvm-active-01",
            state: "RUNNING",
            imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:runner",
            imageVersion: "12",
            startedAt: new Date("2026-09-06T12:00:00Z"),
          },
        ],
      });
      microvmsMock.on(TerminateMicrovmCommand).resolves({});

      // 2. S3 bucket versions
      s3Mock.on(ListObjectVersionsCommand).resolves({
        Versions: [{ Key: "runs/run-1/manifest.json", VersionId: "v1" }],
        DeleteMarkers: [{ Key: "runs/run-1/deleted.json", VersionId: "d1" }],
      });
      s3Mock.on(DeleteObjectsCommand).resolves({});

      // 3. Secrets
      secretsMock.on(ListSecretsCommand).resolves({
        SecretList: [
          { Name: "pi-cloud-agents/pi-cloud-agents-test/auth/anthropic" },
          { Name: "pi-cloud-agents/pi-cloud-agents-test/github-token" },
        ],
      });
      secretsMock.on(DeleteSecretCommand).resolves({});

      // 4. CloudFormation Stacks: deleteStack polls DescribeStacks until empty
      let imageStackDeleted = false;
      let coreStackDeleted = false;

      cfnMock.on(DescribeStacksCommand, { StackName: "pi-cloud-agents-test" }).callsFake(() => {
        if (coreStackDeleted) return { Stacks: [] };
        return {
          Stacks: [
            {
              StackName: "pi-cloud-agents-test",
              CreationTime: new Date(),
              StackStatus: "CREATE_COMPLETE",
              Outputs: [{ OutputKey: "BucketName", OutputValue: "test-bucket" }],
            },
          ],
        };
      });

      cfnMock
        .on(DescribeStacksCommand, { StackName: "pi-cloud-agents-test-image" })
        .callsFake(() => {
          if (imageStackDeleted) return { Stacks: [] };
          return {
            Stacks: [
              {
                StackName: "pi-cloud-agents-test-image",
                CreationTime: new Date(),
                StackStatus: "CREATE_COMPLETE",
              },
            ],
          };
        });

      cfnMock.on(DeleteStackCommand, { StackName: "pi-cloud-agents-test-image" }).callsFake(() => {
        imageStackDeleted = true;
        return {};
      });

      cfnMock.on(DeleteStackCommand, { StackName: "pi-cloud-agents-test" }).callsFake(() => {
        coreStackDeleted = true;
        return {};
      });

      const res = await executeCloudDestroy({
        config: mockConfig,
        force: true,
        deleteLocalConfig: false,
      });

      expect(res.success).toBe(true);
      expect(res.terminatedVmsCount).toBe(1);
      expect(res.deletedSecretsCount).toBe(2);
      expect(res.deletedStacks).toContain("pi-cloud-agents-test-image");
      expect(res.deletedStacks).toContain("pi-cloud-agents-test");
      expect(res.message).toContain("completely destroyed");

      expect(microvmsMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(1);
      expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(1);
      expect(secretsMock.commandCalls(DeleteSecretCommand)).toHaveLength(2);
      expect(cfnMock.commandCalls(DeleteStackCommand)).toHaveLength(2);
    });
  });

  describe("Extension command handlers", () => {
    it("handles /cloud update with notification output", async () => {
      let currentSha = "06b2cdab21fba803cef0e88e63ccf9f927bb5f21061490176cbf7289b6d35291";
      try {
        const distManifest = JSON.parse(
          fs.readFileSync(path.resolve(process.cwd(), "dist/image/manifest.json"), "utf-8"),
        );
        if (distManifest.sha256) {
          currentSha = distManifest.sha256;
        }
      } catch {}

      cfnMock.on(DescribeStacksCommand).resolves({
        Stacks: [
          {
            StackName: "pi-cloud-agents-core",
            StackStatus: "CREATE_COMPLETE",
            Outputs: coreStackOutputs,
            CreationTime: new Date(),
          },
        ],
      });

      microvmsMock.on(GetMicrovmImageCommand).resolves({
        imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:runner",
        latestActiveImageVersion: "12",
      });

      microvmsMock.on(GetMicrovmImageVersionCommand).resolves({
        imageVersion: "12",
        codeArtifact: { uri: `s3://test-bucket/runner/${currentSha}.zip` },
        environmentVariables: { PI_CLOUD_RUNNER_SHA: currentSha },
        description: JSON.stringify({
          manifestSha256: currentSha,
          piVersion: "0.85.1",
        }),
      });

      s3Mock.on(PutObjectCommand).resolves({});

      const res = await handleCloudUpdateCommand([], { hasUI: false });
      expect(res.handled).toBe(true);
      expect(res.output).toContain("✓");
    });

    it("handles /cloud destroy with confirmation skip", async () => {
      microvmsMock.on(ListMicrovmsCommand).resolves({ items: [] });
      s3Mock.on(ListObjectVersionsCommand).resolves({ Versions: [] });
      secretsMock.on(ListSecretsCommand).resolves({ SecretList: [] });
      cfnMock.on(DeleteStackCommand).resolves({});
      cfnMock.on(DescribeStacksCommand).resolves({ Stacks: [] });

      const res = await handleCloudDestroyCommand(["--yes", "--force"], { hasUI: false });
      expect(res.handled).toBe(true);
      expect(res.output).toContain("Destroyed resources summary");
      expect(res.output).toContain("Zero billable resources remain");
    });
  });
});
