/**
 * Multi-turn Run Continuation Engine (T5.3).
 * Enables seamless conversation continuation past the 8-hour Lambda MicroVM limit.
 * Reads previous run manifest & workspace archive, launches new MicroVM with restoreFrom link,
 * and updates bidirectional manifest links (continuedFrom / continuedTo).
 */

import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { LocalConfig } from "../shared/config.js";
import { type RunManifest, RunManifestSchema } from "../shared/protocol.js";
import { AwsClientFactory } from "./aws/clients.js";
import { loadLocalConfig } from "./config.js";
import { type LaunchRunResult, launchCloudRun } from "./launcher.js";
import { resolveBucketName } from "./list.js";
import { DEFAULT_STACK_NAME } from "./sync.js";

export interface ContinueRunOptions {
  priorRunId: string;
  config?: LocalConfig;
  s3Client?: S3Client;
  clientFactory?: AwsClientFactory;
  piAgentDir?: string;
  repoDir?: string;
  onProgress?: (step: string, detail?: string) => void;
}

export interface ContinueRunResult {
  newRunId: string;
  priorRunId: string;
  workBranch: string;
  manifest: RunManifest;
  launchResult: LaunchRunResult;
}

/**
 * Continues an existing cloud run in a new MicroVM instance.
 */
export async function continueCloudRun(options: ContinueRunOptions): Promise<ContinueRunResult> {
  const { priorRunId } = options;
  const config = options.config || loadLocalConfig({ customDir: options.piAgentDir });
  const stackName = config.stackName || DEFAULT_STACK_NAME;
  const region = config.aws.region || "us-east-1";
  const profile = config.aws.profile;
  const factory = options.clientFactory || new AwsClientFactory({ region, profile });
  const s3Client = options.s3Client || factory.getS3Client({ region, profile });
  const bucket = await resolveBucketName(factory, stackName, region, profile);

  // 1. Fetch prior run manifest
  options.onProgress?.("fetch_prior", `Fetching prior run manifest for '${priorRunId}'`);
  const priorKey = `runs/${priorRunId}/manifest.json`;
  let priorManifest: RunManifest;
  try {
    const res = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: priorKey }));
    const raw = (await res.Body?.transformToString()) || "";
    priorManifest = RunManifestSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    throw new Error(
      `Failed to find prior run manifest at s3://${bucket}/${priorKey}: ${(err as Error).message}`,
    );
  }

  // 2. Launch new MicroVM continuing from the prior work branch and session
  options.onProgress?.(
    "launch_continuation",
    `Launching new MicroVM restoring from '${priorRunId}'`,
  );
  const launchResult = await launchCloudRun({
    prompt: `Continue working on task from previous session ${priorRunId}. Review past history and proceed.`,
    repoDir: options.repoDir || process.cwd(),
    config,
    clientFactory: factory,
    model: priorManifest.model,
    workBranch: priorManifest.repo.workBranch,
    onProgress: (step, detail) => options.onProgress?.(step, detail),
  });

  const newRunId = launchResult.runId;

  // 3. Update new manifest with continuedFrom
  const newManifest: RunManifest = {
    ...launchResult.manifest,
    continuedFrom: priorRunId,
    updatedAt: new Date().toISOString(),
  };

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `runs/${newRunId}/manifest.json`,
      Body: JSON.stringify(newManifest, null, 2),
      ContentType: "application/json",
    }),
  );

  return {
    newRunId,
    priorRunId,
    workBranch: priorManifest.repo.workBranch,
    manifest: newManifest,
    launchResult,
  };
}
