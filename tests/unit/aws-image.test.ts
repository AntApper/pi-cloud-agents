import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
  DeleteMicrovmImageVersionCommand,
  GetMicrovmImageBuildCommand,
  GetMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ListManagedMicrovmImageVersionsCommand,
  ListManagedMicrovmImagesCommand,
  ListMicrovmImageBuildsCommand,
  ListMicrovmImageVersionsCommand,
} from "@aws-sdk/client-lambda-microvms";
import { HeadObjectCommand, NotFound, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type MicrovmImageBuildError,
  MicrovmImageManager,
  resolveLatestBaseImage,
  uploadArtifactIfMissing,
} from "../../core/aws/image.js";

const s3Mock = mockClient(S3Client);
const microvmsMock = mockClient(LambdaMicrovmsClient);
const cwMock = mockClient(CloudWatchLogsClient);

describe("T3.3 AWS MicroVM Image Manager", () => {
  let tmpDir: string;
  let testFilePath: string;
  const testContent = "test-artifact-payload-content";

  beforeEach(() => {
    s3Mock.reset();
    microvmsMock.reset();
    cwMock.reset();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aws-image-test-"));
    testFilePath = path.join(tmpDir, "test.zip");
    fs.writeFileSync(testFilePath, testContent);
  });

  describe("uploadArtifactIfMissing", () => {
    it("skips upload when S3 HeadObject confirms object exists with matching SHA256", async () => {
      const s3Client = new S3Client({ region: "us-east-1" });
      const crypto = await import("node:crypto");
      const sha = crypto.createHash("sha256").update(testContent).digest("hex");

      s3Mock.on(HeadObjectCommand).resolves({
        Metadata: {
          sha256: sha,
        },
      });

      const result = await uploadArtifactIfMissing(
        s3Client,
        "test-bucket",
        `runner/${sha}.zip`,
        testFilePath,
      );

      expect(result.uploaded).toBe(false);
      expect(result.sha256).toBe(sha);
      expect(result.s3Uri).toBe(`s3://test-bucket/runner/${sha}.zip`);
      expect(s3Mock.commandCalls(PutObjectCommand).length).toBe(0);
    });

    it("uploads artifact when S3 HeadObject returns NotFound", async () => {
      const s3Client = new S3Client({ region: "us-east-1" });
      const crypto = await import("node:crypto");
      const sha = crypto.createHash("sha256").update(testContent).digest("hex");

      s3Mock.on(HeadObjectCommand).rejects(new NotFound({ message: "Not Found", $metadata: {} }));
      s3Mock.on(PutObjectCommand).resolves({});

      const result = await uploadArtifactIfMissing(
        s3Client,
        "test-bucket",
        `runner/${sha}.zip`,
        testFilePath,
      );

      expect(result.uploaded).toBe(true);
      expect(result.sha256).toBe(sha);
      expect(s3Mock.commandCalls(PutObjectCommand).length).toBe(1);
      const putCall = s3Mock.commandCalls(PutObjectCommand)[0];
      expect(putCall).toBeDefined();
      expect(putCall?.args[0].input).toMatchObject({
        Bucket: "test-bucket",
        Key: `runner/${sha}.zip`,
        ContentType: "application/zip",
        Metadata: { sha256: sha },
      });
    });

    it("re-uploads artifact when existing S3 object SHA256 does not match", async () => {
      const s3Client = new S3Client({ region: "us-east-1" });
      const crypto = await import("node:crypto");
      const sha = crypto.createHash("sha256").update(testContent).digest("hex");

      s3Mock.on(HeadObjectCommand).resolves({
        Metadata: {
          sha256: "different-stale-sha256",
        },
      });
      s3Mock.on(PutObjectCommand).resolves({});

      const result = await uploadArtifactIfMissing(
        s3Client,
        "test-bucket",
        "custom-key.zip",
        testFilePath,
      );

      expect(result.uploaded).toBe(true);
      expect(result.sha256).toBe(sha);
      expect(s3Mock.commandCalls(PutObjectCommand).length).toBe(1);
    });

    it("throws error when expectedSha256 does not match local file", async () => {
      const s3Client = new S3Client({ region: "us-east-1" });
      await expect(
        uploadArtifactIfMissing(
          s3Client,
          "test-bucket",
          "key.zip",
          testFilePath,
          "wrong-expected-sha",
        ),
      ).rejects.toThrow(/SHA256 mismatch/);
    });
  });

  describe("resolveLatestBaseImage", () => {
    it("resolves the latest available managed base image and version", async () => {
      const microvmsClient = new LambdaMicrovmsClient({ region: "us-east-1" });

      microvmsMock.on(ListManagedMicrovmImagesCommand).resolves({
        items: [
          {
            imageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
            createdAt: new Date(),
          },
          { imageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2-1", createdAt: new Date() },
        ],
      });

      microvmsMock.on(ListManagedMicrovmImageVersionsCommand).resolves({
        items: [
          {
            imageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
            imageVersion: "1.2.0",
            status: "AVAILABLE",
            createdAt: new Date(),
          },
          {
            imageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
            imageVersion: "1.1.0",
            status: "DEPRECATED",
            createdAt: new Date(),
          },
        ],
      });

      const baseInfo = await resolveLatestBaseImage(microvmsClient, "us-east-1");
      expect(baseInfo.baseImageArn).toBe("arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1");
      expect(baseInfo.baseImageVersion).toBe("1.2.0");
    });

    it("throws error when no managed base images are available", async () => {
      const microvmsClient = new LambdaMicrovmsClient({ region: "us-east-1" });
      microvmsMock.on(ListManagedMicrovmImagesCommand).resolves({ items: [] });

      await expect(resolveLatestBaseImage(microvmsClient, "us-east-1")).rejects.toThrow(
        /No managed MicroVM base image found/,
      );
    });
  });

  describe("MicrovmImageManager", () => {
    it("deploys runner and controller artifacts with content-addressed keys", async () => {
      const manager = new MicrovmImageManager({ region: "us-east-1" });

      const controllerFilePath = path.join(tmpDir, "controller.zip");
      fs.writeFileSync(controllerFilePath, "controller-payload-data");

      s3Mock.on(HeadObjectCommand).rejects(new NotFound({ message: "Not Found", $metadata: {} }));
      s3Mock.on(PutObjectCommand).resolves({});

      const result = await manager.deployImageArtifacts({
        bucket: "my-artifact-bucket",
        runnerZipPath: testFilePath,
        controllerZipPath: controllerFilePath,
      });

      expect(result.runnerUploaded).toBe(true);
      expect(result.runnerKey).toMatch(/^runner\/[a-f0-9]{64}\.zip$/);
      expect(result.runnerS3Uri).toContain("my-artifact-bucket");

      expect(result.controllerUploaded).toBe(true);
      expect(result.controllerKey).toMatch(/^controller\/[a-f0-9]{64}\.zip$/);
      expect(result.controllerS3Uri).toContain("my-artifact-bucket");
    });

    it("waitForImageReady polls until image state is CREATED and version is ACTIVE", async () => {
      const manager = new MicrovmImageManager({ region: "us-east-1" });

      // First poll: CREATING
      // Second poll: CREATED with active version 1.0
      microvmsMock
        .on(GetMicrovmImageCommand, { imageIdentifier: "pi-cloud-agent" })
        .resolvesOnce({
          name: "pi-cloud-agent",
          imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agent",
          state: "CREATING",
          latestActiveImageVersion: undefined,
        })
        .resolves({
          name: "pi-cloud-agent",
          imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agent",
          state: "CREATED",
          latestActiveImageVersion: "1.0",
        });

      microvmsMock
        .on(GetMicrovmImageVersionCommand, {
          imageIdentifier: "pi-cloud-agent",
          imageVersion: "1.0",
        })
        .resolves({
          baseImageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
          buildRoleArn: "arn:aws:iam::123456789012:role/BuildRole",
          codeArtifact: { uri: "s3://bucket/runner/1.zip" },
          state: "SUCCESSFUL",
          status: "ACTIVE",
          imageVersion: "1.0",
        });

      const progressEvents: Array<{ state?: string; version?: string }> = [];
      const result = await manager.waitForImageReady({
        imageName: "pi-cloud-agent",
        targetVersion: "1.0",
        pollIntervalMs: 10,
        timeoutMs: 5000,
        onProgress: (p) => progressEvents.push({ state: p.state, version: p.version }),
      });

      expect(result.imageName).toBe("pi-cloud-agent");
      expect(result.version).toBe("1.0");
      expect(result.state).toBe("CREATED");
      expect(result.status).toBe("ACTIVE");
      expect(progressEvents.length).toBeGreaterThan(0);
    });

    it("waitForImageReady captures CloudWatch logs and throws on image build failure", async () => {
      const manager = new MicrovmImageManager({ region: "us-east-1" });

      microvmsMock.on(GetMicrovmImageCommand).resolves({
        name: "pi-cloud-agent",
        imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agent",
        state: "CREATE_FAILED",
      });

      cwMock.on(FilterLogEventsCommand).resolves({
        events: [
          { message: "Step 1/5: FROM public.ecr.aws/lambda/microvms:al2023-minimal" },
          { message: "Step 2/5: RUN dnf install -y nodejs22" },
          { message: "ERROR: failed to resolve package repository" },
        ],
      });

      let capturedError: MicrovmImageBuildError | undefined;
      try {
        await manager.waitForImageReady({
          imageName: "pi-cloud-agent",
          pollIntervalMs: 10,
          timeoutMs: 2000,
        });
      } catch (err) {
        capturedError = err as MicrovmImageBuildError;
      }

      expect(capturedError).toBeDefined();
      expect(capturedError?.name).toBe("MicrovmImageBuildError");
      expect(capturedError?.imageName).toBe("pi-cloud-agent");
      expect(capturedError?.buildState).toBe("CREATE_FAILED");
      expect(capturedError?.buildLogs).toContain("ERROR: failed to resolve package repository");
      expect(capturedError?.message).toContain("failed to resolve package repository");
    });

    it("describes image with active version, runner SHA, pi version, and memory snapshot size", async () => {
      const manager = new MicrovmImageManager({ region: "us-east-1" });

      microvmsMock.on(GetMicrovmImageCommand).resolves({
        name: "pi-cloud-agent",
        imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agent",
        state: "CREATED",
        latestActiveImageVersion: "1.0",
      });

      microvmsMock.on(GetMicrovmImageVersionCommand).resolves({
        baseImageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
        baseImageVersion: "1.2.0",
        buildRoleArn: "arn:aws:iam::123456789012:role/BuildRole",
        state: "SUCCESSFUL",
        status: "ACTIVE",
        codeArtifact: {
          uri: "s3://my-bucket/runner/abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890.zip",
        },
        tags: {
          "pi-cloud-agents:pi-version": "0.85.1",
        },
      });

      microvmsMock.on(ListMicrovmImageBuildsCommand).resolves({
        items: [
          {
            imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agent",
            imageVersion: "1.0",
            buildId: "build-12345",
            buildState: "SUCCESSFUL",
            architecture: "ARM_64",
            chipset: "GRAVITON",
            chipsetGeneration: "1",
            createdAt: new Date(),
          },
        ],
      });

      microvmsMock.on(GetMicrovmImageBuildCommand).resolves({
        imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agent",
        imageVersion: "1.0",
        buildId: "build-12345",
        buildState: "SUCCESSFUL",
        snapshotBuild: {
          memorySnapshotSizeInBytes: 134217728, // 128 MB
          codeInstallSizeInBytes: 52428800,
          diskSnapshotSizeInBytes: 209715200,
        },
      });

      const desc = await manager.describeImage("pi-cloud-agent");

      expect(desc.name).toBe("pi-cloud-agent");
      expect(desc.version).toBe("1.0");
      expect(desc.runnerSha).toBe(
        "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      );
      expect(desc.piVersion).toBe("0.85.1");
      expect(desc.baseImageArn).toBe("arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1");
      expect(desc.baseImageVersion).toBe("1.2.0");
      expect(desc.memorySnapshotBytes).toBe(134217728);
    });

    it("checks image drift detecting changes in runner SHA", async () => {
      const manager = new MicrovmImageManager({ region: "us-east-1" });

      microvmsMock.on(GetMicrovmImageCommand).resolves({
        name: "pi-cloud-agent",
        imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agent",
        state: "CREATED",
        latestActiveImageVersion: "1.0",
      });

      microvmsMock.on(GetMicrovmImageVersionCommand).resolves({
        baseImageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
        buildRoleArn: "arn:aws:iam::123456789012:role/BuildRole",
        codeArtifact: {
          uri: "s3://bucket/runner/1111111111111111111111111111111111111111111111111111111111111111.zip",
        },
      });
      microvmsMock.on(ListMicrovmImageBuildsCommand).resolves({ items: [] });

      // Case 1: Drift exists (different SHA)
      const driftResult = await manager.checkImageDrift(
        "pi-cloud-agent",
        "2222222222222222222222222222222222222222222222222222222222222222",
      );
      expect(driftResult.needsUpdate).toBe(true);
      expect(driftResult.currentSha).toBe(
        "1111111111111111111111111111111111111111111111111111111111111111",
      );
      expect(driftResult.targetSha).toBe(
        "2222222222222222222222222222222222222222222222222222222222222222",
      );

      // Case 2: In sync (same SHA)
      const syncResult = await manager.checkImageDrift(
        "pi-cloud-agent",
        "1111111111111111111111111111111111111111111111111111111111111111",
      );
      expect(syncResult.needsUpdate).toBe(false);
    });

    it("prunes older versions retaining the top keep count", async () => {
      const manager = new MicrovmImageManager({ region: "us-east-1" });

      const baseVersionMock = {
        baseImageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
        buildRoleArn: "arn:aws:iam::123456789012:role/BuildRole",
        codeArtifact: { uri: "s3://bucket/runner.zip" },
        imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agent",
        state: "SUCCESSFUL" as const,
      };

      microvmsMock.on(ListMicrovmImageVersionsCommand).resolves({
        items: [
          {
            ...baseVersionMock,
            imageVersion: "1.3",
            createdAt: new Date("2026-03-01T00:00:00Z"),
            status: "ACTIVE",
          },
          {
            ...baseVersionMock,
            imageVersion: "1.2",
            createdAt: new Date("2026-02-01T00:00:00Z"),
            status: "INACTIVE",
          },
          {
            ...baseVersionMock,
            imageVersion: "1.1",
            createdAt: new Date("2026-01-01T00:00:00Z"),
            status: "INACTIVE",
          },
          {
            ...baseVersionMock,
            imageVersion: "1.0",
            createdAt: new Date("2025-12-01T00:00:00Z"),
            status: "INACTIVE",
          },
        ],
      });

      microvmsMock.on(DeleteMicrovmImageVersionCommand).resolves({});

      const pruneResult = await manager.pruneVersions("pi-cloud-agent", 2);

      expect(pruneResult.keptVersions).toEqual(["1.3", "1.2"]);
      expect(pruneResult.prunedVersions).toEqual(["1.1", "1.0"]);
      expect(microvmsMock.commandCalls(DeleteMicrovmImageVersionCommand).length).toBe(2);
    });
  });
});
