import crypto from "node:crypto";
import fs from "node:fs";
import {
  ResourceNotFoundException as CWResourceNotFoundException,
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  type FilteredLogEvent,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  DeleteMicrovmImageVersionCommand,
  GetMicrovmImageBuildCommand,
  GetMicrovmImageCommand,
  type GetMicrovmImageOutput,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ListManagedMicrovmImageVersionsCommand,
  ListManagedMicrovmImagesCommand,
  ListMicrovmImageBuildsCommand,
  ListMicrovmImageVersionsCommand,
  type MicrovmImageVersionSummary,
  ResourceNotFoundException as MicrovmResourceNotFoundException,
} from "@aws-sdk/client-lambda-microvms";
import {
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { collectPages } from "./paginate.js";

export interface UploadArtifactResult {
  uploaded: boolean;
  key: string;
  sha256: string;
  s3Uri: string;
  bucket: string;
}

/**
 * Checks if an artifact already exists on S3 with matching SHA-256 metadata.
 * If found and valid, skips re-uploading; otherwise uploads the local file.
 */
export async function uploadArtifactIfMissing(
  s3Client: S3Client,
  bucket: string,
  key: string,
  localFilePath: string,
  expectedSha256?: string,
): Promise<UploadArtifactResult> {
  const fileBuffer = fs.readFileSync(localFilePath);
  const computedSha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");

  if (expectedSha256 && computedSha256 !== expectedSha256) {
    throw new Error(
      `SHA256 mismatch for artifact '${localFilePath}': expected ${expectedSha256} but computed ${computedSha256}`,
    );
  }

  const s3Uri = `s3://${bucket}/${key}`;

  // Check if object exists with matching SHA-256 metadata
  try {
    const head = await s3Client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );

    const existingSha = head.Metadata?.sha256 || head.Metadata?.["sha-256"];
    if (existingSha === computedSha256 || (!existingSha && key.includes(computedSha256))) {
      return {
        uploaded: false,
        key,
        sha256: computedSha256,
        s3Uri,
        bucket,
      };
    }
  } catch (err: unknown) {
    const name = (err as Error)?.name || "";
    const isNotFound =
      err instanceof NotFound ||
      err instanceof NoSuchKey ||
      name === "NotFound" ||
      name === "NoSuchKey" ||
      name === "404";

    if (!isNotFound) {
      throw err;
    }
  }

  // Object does not exist or SHA mismatch: upload
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fileBuffer,
      ContentType: "application/zip",
      Metadata: {
        sha256: computedSha256,
      },
    }),
  );

  return {
    uploaded: true,
    key,
    sha256: computedSha256,
    s3Uri,
    bucket,
  };
}

export interface BaseImageInfo {
  baseImageArn: string;
  baseImageVersion: string;
}

/**
 * Resolves the latest available managed MicroVM base image ARN and active version.
 */
export async function resolveLatestBaseImage(
  lambdaMicrovmsClient: LambdaMicrovmsClient,
  region?: string,
): Promise<BaseImageInfo> {
  const imagesOutput = await lambdaMicrovmsClient.send(new ListManagedMicrovmImagesCommand({}));
  const images = (imagesOutput.items ?? [])
    .map((img) => img.imageArn)
    .filter((arn): arn is string => Boolean(arn));

  if (images.length === 0) {
    throw new Error(
      `No managed MicroVM base image found in region ${region || "target region"}. Ensure Lambda MicroVMs are supported in this region.`,
    );
  }

  // Select the base image (preferring AL2023 if available)
  const baseImageArn = images.find((arn) => arn.includes("al2023")) || images[0];
  if (!baseImageArn) {
    throw new Error(`No managed MicroVM base image found in region ${region || "target region"}.`);
  }

  const versionsOutput = await lambdaMicrovmsClient.send(
    new ListManagedMicrovmImageVersionsCommand({
      imageIdentifier: baseImageArn,
    }),
  );

  const versions = versionsOutput.items ?? [];
  const availableVersions = versions.filter((v) => v.status === "AVAILABLE");
  const targetVersion = availableVersions[0] || versions[0];

  if (!targetVersion?.imageVersion) {
    throw new Error(
      `No available managed MicroVM base image versions found for base image '${baseImageArn}'.`,
    );
  }

  return {
    baseImageArn,
    baseImageVersion: targetVersion.imageVersion,
  };
}

export class MicrovmImageBuildError extends Error {
  readonly imageName: string;
  readonly targetVersion?: string;
  readonly buildState?: string;
  readonly buildLogs: string[];

  constructor(
    message: string,
    options: {
      imageName: string;
      targetVersion?: string;
      buildState?: string;
      buildLogs?: string[];
    },
  ) {
    super(message);
    this.name = "MicrovmImageBuildError";
    this.imageName = options.imageName;
    this.targetVersion = options.targetVersion;
    this.buildState = options.buildState;
    this.buildLogs = options.buildLogs ?? [];
  }
}

export interface MicrovmImageManagerOptions {
  microvmsClient?: LambdaMicrovmsClient;
  s3Client?: S3Client;
  cwClient?: CloudWatchLogsClient;
  region?: string;
}

export interface DeployArtifactsParams {
  bucket: string;
  runnerZipPath: string;
  controllerZipPath: string;
}

export interface DeployArtifactsResult {
  runnerKey: string;
  runnerSha: string;
  runnerUploaded: boolean;
  runnerS3Uri: string;
  controllerKey: string;
  controllerSha: string;
  controllerUploaded: boolean;
  controllerS3Uri: string;
}

export interface WaitForImageReadyParams {
  imageName: string;
  targetVersion?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onProgress?: (progress: {
    state?: string;
    version?: string;
    versionState?: string;
    versionStatus?: string;
    elapsedMs: number;
  }) => void;
}

export interface ImageReadyResult {
  imageArn: string;
  imageName: string;
  version: string;
  state: string;
  status: string;
}

export interface ImageDescription {
  arn: string;
  name: string;
  version?: string;
  runnerSha?: string;
  piVersion?: string;
  baseImageArn?: string;
  baseImageVersion?: string;
  memorySnapshotBytes?: number;
  state?: string;
  status?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface DriftCheckResult {
  needsUpdate: boolean;
  currentSha?: string;
  targetSha: string;
  currentVersion?: string;
  imageArn?: string;
}

export interface PruneVersionsResult {
  prunedVersions: string[];
  keptVersions: string[];
}

/**
 * MicroVM Image Manager.
 * Orchestrates artifact uploads, build polling, CloudWatch diagnostic extraction,
 * image drift detection, and version pruning.
 */
export class MicrovmImageManager {
  private readonly microvmsClient: LambdaMicrovmsClient;
  private readonly s3Client: S3Client;
  private readonly cwClient: CloudWatchLogsClient;
  private readonly region: string;

  constructor(options: MicrovmImageManagerOptions = {}) {
    this.region = options.region ?? process.env.AWS_REGION ?? "us-east-1";
    this.microvmsClient =
      options.microvmsClient ?? new LambdaMicrovmsClient({ region: this.region });
    this.s3Client = options.s3Client ?? new S3Client({ region: this.region });
    this.cwClient = options.cwClient ?? new CloudWatchLogsClient({ region: this.region });
  }

  /**
   * Uploads runner and controller zip artifacts to S3 with content-addressed keys.
   * Format: runner/<sha256>.zip and controller/<sha256>.zip
   */
  async deployImageArtifacts(params: DeployArtifactsParams): Promise<DeployArtifactsResult> {
    const runnerBuf = fs.readFileSync(params.runnerZipPath);
    const runnerSha = crypto.createHash("sha256").update(runnerBuf).digest("hex");
    const runnerKey = `runner/${runnerSha}.zip`;

    const controllerBuf = fs.readFileSync(params.controllerZipPath);
    const controllerSha = crypto.createHash("sha256").update(controllerBuf).digest("hex");
    const controllerKey = `controller/${controllerSha}.zip`;

    const [runnerUpload, controllerUpload] = await Promise.all([
      uploadArtifactIfMissing(
        this.s3Client,
        params.bucket,
        runnerKey,
        params.runnerZipPath,
        runnerSha,
      ),
      uploadArtifactIfMissing(
        this.s3Client,
        params.bucket,
        controllerKey,
        params.controllerZipPath,
        controllerSha,
      ),
    ]);

    return {
      runnerKey,
      runnerSha,
      runnerUploaded: runnerUpload.uploaded,
      runnerS3Uri: runnerUpload.s3Uri,
      controllerKey,
      controllerSha,
      controllerUploaded: controllerUpload.uploaded,
      controllerS3Uri: controllerUpload.s3Uri,
    };
  }

  /**
   * Polls GetMicrovmImage and GetMicrovmImageVersion until the image and version are ready.
   * On failure, automatically retrieves CloudWatch build diagnostics and raises MicrovmImageBuildError.
   */
  async waitForImageReady(params: WaitForImageReadyParams): Promise<ImageReadyResult> {
    const pollInterval = params.pollIntervalMs ?? 10_000;
    const timeoutMs = params.timeoutMs ?? 20 * 60 * 1000;
    const startTime = Date.now();
    const deadline = startTime + timeoutMs;

    while (Date.now() <= deadline) {
      const elapsedMs = Date.now() - startTime;

      let imageDesc: GetMicrovmImageOutput;
      try {
        imageDesc = await this.microvmsClient.send(
          new GetMicrovmImageCommand({
            imageIdentifier: params.imageName,
          }),
        );
      } catch (err: unknown) {
        if (
          err instanceof MicrovmResourceNotFoundException ||
          (err as Error)?.name === "ResourceNotFoundException"
        ) {
          // Image may still be initializing in CloudFormation
          await this.sleep(pollInterval);
          continue;
        }
        throw err;
      }

      const imageState = imageDesc.state ?? "UNKNOWN";
      const activeVersion = imageDesc.latestActiveImageVersion;
      const failedVersion = imageDesc.latestFailedImageVersion;
      const targetVersion = params.targetVersion ?? activeVersion;

      // Check if whole image creation failed
      if (imageState === "CREATE_FAILED" || imageState === "UPDATE_FAILED") {
        const buildLogs = await this.fetchBuildLogs(params.imageName);
        const logPreview =
          buildLogs.length > 0 ? `\n--- Build Logs ---\n${buildLogs.join("\n")}` : "";
        throw new MicrovmImageBuildError(
          `MicroVM image '${params.imageName}' failed with state '${imageState}'.${logPreview}`,
          {
            imageName: params.imageName,
            targetVersion,
            buildState: imageState,
            buildLogs,
          },
        );
      }

      // Check if targeted version explicitly failed
      if (targetVersion && failedVersion === targetVersion) {
        const buildLogs = await this.fetchBuildLogs(params.imageName);
        const logPreview =
          buildLogs.length > 0 ? `\n--- Build Logs ---\n${buildLogs.join("\n")}` : "";
        throw new MicrovmImageBuildError(
          `MicroVM image version '${targetVersion}' for image '${params.imageName}' failed.${logPreview}`,
          {
            imageName: params.imageName,
            targetVersion,
            buildState: "FAILED",
            buildLogs,
          },
        );
      }

      // Query version details if targetVersion is known
      let versionState: string | undefined;
      let versionStatus: string | undefined;

      if (targetVersion) {
        try {
          const versionDesc = await this.microvmsClient.send(
            new GetMicrovmImageVersionCommand({
              imageIdentifier: params.imageName,
              imageVersion: targetVersion,
            }),
          );
          versionState = versionDesc.state;
          versionStatus = versionDesc.status;

          if (versionState === "FAILED") {
            const buildLogs = await this.fetchBuildLogs(params.imageName);
            const logPreview =
              buildLogs.length > 0 ? `\n--- Build Logs ---\n${buildLogs.join("\n")}` : "";
            throw new MicrovmImageBuildError(
              `MicroVM image version '${targetVersion}' failed to build (state: FAILED).${logPreview}`,
              {
                imageName: params.imageName,
                targetVersion,
                buildState: "FAILED",
                buildLogs,
              },
            );
          }
        } catch (verErr: unknown) {
          if ((verErr as Error) instanceof MicrovmImageBuildError) throw verErr;
          // Version might not be registered yet; continue polling
        }
      }

      params.onProgress?.({
        state: imageState,
        version: targetVersion,
        versionState,
        versionStatus,
        elapsedMs,
      });

      // Check for success condition
      const isImageReady = imageState === "CREATED" || imageState === "UPDATED";
      const isVersionReady =
        (!targetVersion && activeVersion) ||
        (targetVersion &&
          (versionStatus === "ACTIVE" ||
            versionState === "SUCCESSFUL" ||
            activeVersion === targetVersion));

      if (isImageReady && isVersionReady) {
        return {
          imageArn:
            imageDesc.imageArn ?? `arn:aws:lambda:${this.region}:microvm-image:${params.imageName}`,
          imageName: params.imageName,
          version: targetVersion || activeVersion || "1.0",
          state: imageState,
          status: versionStatus || "ACTIVE",
        };
      }

      await this.sleep(pollInterval);
    }

    throw new Error(
      `Timed out waiting for MicroVM image '${params.imageName}' build to complete after ${Math.round(timeoutMs / 1000)}s`,
    );
  }

  /**
   * Fetches the last 50 log lines from the CloudWatch build log group.
   */
  async fetchBuildLogs(imageName: string, maxLines = 50): Promise<string[]> {
    const logGroupNames = [
      `/aws/lambda/microvms/${imageName}`,
      `/aws/lambda-microvms/${imageName}`,
    ];

    for (const group of logGroupNames) {
      try {
        const response = await this.cwClient.send(
          new FilterLogEventsCommand({
            logGroupName: group,
            limit: maxLines,
            interleaved: true,
          }),
        );

        const events: FilteredLogEvent[] = response.events ?? [];
        if (events.length > 0) {
          return events.map((e) => e.message?.trim()).filter((m): m is string => Boolean(m));
        }
      } catch (err: unknown) {
        if (
          !(err instanceof CWResourceNotFoundException) &&
          (err as Error)?.name !== "ResourceNotFoundException"
        ) {
          throw err;
        }
      }
    }

    return [];
  }

  /**
   * Describes the current MicroVM image and its active version for drift checks and dashboard.
   */
  async describeImage(imageName: string): Promise<ImageDescription> {
    const imageDesc = await this.microvmsClient.send(
      new GetMicrovmImageCommand({
        imageIdentifier: imageName,
      }),
    );

    const activeVersion = imageDesc.latestActiveImageVersion;
    let baseImageArn: string | undefined;
    let baseImageVersion: string | undefined;
    let runnerSha: string | undefined;
    let piVersion: string | undefined;
    let memorySnapshotBytes: number | undefined;
    let versionStatus: string | undefined;
    let createdAt: Date | undefined = imageDesc.createdAt;
    let updatedAt: Date | undefined = imageDesc.updatedAt;

    if (activeVersion) {
      try {
        const versionDesc = await this.microvmsClient.send(
          new GetMicrovmImageVersionCommand({
            imageIdentifier: imageName,
            imageVersion: activeVersion,
          }),
        );

        baseImageArn = versionDesc.baseImageArn;
        baseImageVersion = versionDesc.baseImageVersion;
        versionStatus = versionDesc.status;
        createdAt = versionDesc.createdAt ?? createdAt;
        updatedAt = versionDesc.updatedAt ?? updatedAt;

        // Extract runnerSha from S3 URI/key, description JSON, tags, or environment variables
        const artifactUri =
          (versionDesc.codeArtifact as { s3Uri?: string; uri?: string } | undefined)?.s3Uri ||
          (versionDesc.codeArtifact as { s3Uri?: string; uri?: string } | undefined)?.uri ||
          "";
        const uriMatch = artifactUri.match(/runner\/([a-f0-9]{64})\.zip/i);
        if (uriMatch) {
          runnerSha = uriMatch[1];
        } else if (versionDesc.tags?.["pi-cloud-agents:runner-sha"]) {
          runnerSha = versionDesc.tags["pi-cloud-agents:runner-sha"];
        } else if (versionDesc.environmentVariables?.PI_CLOUD_RUNNER_SHA) {
          runnerSha = versionDesc.environmentVariables.PI_CLOUD_RUNNER_SHA;
        }

        // Also check version description JSON
        if (versionDesc.description) {
          try {
            const parsedDesc = JSON.parse(versionDesc.description);
            if (!runnerSha && parsedDesc.manifestSha256) {
              runnerSha = parsedDesc.manifestSha256;
            }
            if (!piVersion && parsedDesc.piVersion) {
              piVersion = parsedDesc.piVersion;
            }
          } catch {
            // Not JSON description
          }
        }

        // Extract piVersion from tags or environment variables
        if (versionDesc.tags?.["pi-cloud-agents:pi-version"]) {
          piVersion = versionDesc.tags["pi-cloud-agents:pi-version"];
        } else if (versionDesc.environmentVariables?.PI_VERSION) {
          piVersion = versionDesc.environmentVariables.PI_VERSION;
        }
      } catch {
        // Fall back gracefully if version fetch fails
      }

      try {
        const builds = await this.microvmsClient.send(
          new ListMicrovmImageBuildsCommand({
            imageIdentifier: imageName,
            imageVersion: activeVersion,
          }),
        );

        const firstBuildId = builds.items?.[0]?.buildId;
        if (firstBuildId) {
          const buildDesc = await this.microvmsClient.send(
            new GetMicrovmImageBuildCommand({
              imageIdentifier: imageName,
              imageVersion: activeVersion,
              buildId: firstBuildId,
            }),
          );
          memorySnapshotBytes = buildDesc.snapshotBuild?.memorySnapshotSizeInBytes;
        }
      } catch {
        // Fall back gracefully if build snapshot details are unavailable
      }
    }

    return {
      arn: imageDesc.imageArn ?? `arn:aws:lambda:${this.region}:microvm-image:${imageName}`,
      name: imageName,
      version: activeVersion,
      runnerSha,
      piVersion,
      baseImageArn,
      baseImageVersion,
      memorySnapshotBytes,
      state: imageDesc.state,
      status: versionStatus,
      createdAt,
      updatedAt,
    };
  }

  /**
   * Compares the deployed image's runner SHA with the local runner SHA to detect drift.
   */
  async checkImageDrift(imageName: string, localRunnerSha: string): Promise<DriftCheckResult> {
    try {
      const desc = await this.describeImage(imageName);

      if (!desc.version || !desc.runnerSha) {
        return {
          needsUpdate: true,
          currentSha: desc.runnerSha,
          targetSha: localRunnerSha,
          currentVersion: desc.version,
          imageArn: desc.arn,
        };
      }

      const needsUpdate = desc.runnerSha.toLowerCase() !== localRunnerSha.toLowerCase();
      return {
        needsUpdate,
        currentSha: desc.runnerSha,
        targetSha: localRunnerSha,
        currentVersion: desc.version,
        imageArn: desc.arn,
      };
    } catch (err: unknown) {
      if (
        err instanceof MicrovmResourceNotFoundException ||
        (err as Error)?.name === "ResourceNotFoundException"
      ) {
        return {
          needsUpdate: true,
          targetSha: localRunnerSha,
        };
      }
      throw err;
    }
  }

  /**
   * Prunes older MicroVM image versions to conserve storage costs,
   * retaining the top `keep` active versions (default = 2: latest active + 1 previous).
   */
  async pruneVersions(imageName: string, keep = 2): Promise<PruneVersionsResult> {
    const versions: MicrovmImageVersionSummary[] = await collectPages({
      fetchPage: (nextToken: string | undefined) =>
        this.microvmsClient.send(
          new ListMicrovmImageVersionsCommand({ imageIdentifier: imageName, nextToken }),
        ),
      nextToken: (page) => page.nextToken,
      items: (page) => page.items,
    });

    if (versions.length <= keep) {
      return {
        prunedVersions: [],
        keptVersions: versions.map((v) => v.imageVersion ?? "").filter(Boolean),
      };
    }

    // Sort versions: active status first, then by creation date descending (newest first)
    const sorted = [...versions].sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });

    const kept = sorted.slice(0, keep);
    const toPrune = sorted.slice(keep);

    const prunedVersions: string[] = [];
    for (const ver of toPrune) {
      const verStr = ver.imageVersion;
      if (!verStr) continue;

      try {
        await this.microvmsClient.send(
          new DeleteMicrovmImageVersionCommand({
            imageIdentifier: imageName,
            imageVersion: verStr,
          }),
        );
        prunedVersions.push(verStr);
      } catch (err: unknown) {
        // Ignore if already deleted
        const name = (err as Error)?.name || "";
        if (name !== "ResourceNotFoundException") {
          throw err;
        }
      }
    }

    return {
      prunedVersions,
      keptVersions: kept.map((v) => v.imageVersion ?? "").filter(Boolean),
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
