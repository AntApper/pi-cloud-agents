/**
 * Cloud Agent Control Operations (T4.8).
 * Provides programmatic APIs for stop, suspend, resume, logs, PR creation, and interactive shell auth.
 */

import { type CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  type LambdaMicrovmsClient,
  ResumeMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { LocalConfig } from "../shared/config.js";
import { type RunManifest, RunManifestSchema } from "../shared/protocol.js";
import { AwsClientFactory } from "./aws/clients.js";
import { RunClient } from "./client/run-client.js";
import { loadLocalConfig } from "./config.js";
import { resolveBucketName } from "./list.js";
import { resolveRunId } from "./status.js";
import { DEFAULT_STACK_NAME } from "./sync.js";

export const SHELL_PORT = 8022;
export const DEFAULT_SHELL_TOKEN_EXPIRATION_MINUTES = 15;

export interface CommonControlOptions {
  config?: LocalConfig;
  s3Client?: S3Client;
  microvmsClient?: LambdaMicrovmsClient;
  cwLogsClient?: CloudWatchLogsClient;
  clientFactory?: AwsClientFactory;
  bucket?: string;
  piAgentDir?: string;
  fetchFn?: typeof fetch;
}

export interface StopRunOptions extends CommonControlOptions {
  skipCheckpoint?: boolean;
  force?: boolean;
}

export interface StopRunResult {
  runId: string;
  microvmId?: string;
  status: string;
  checkpointSaved: boolean;
  message: string;
}

export interface SuspendRunOptions extends CommonControlOptions {
  waitForState?: boolean;
  timeoutMs?: number;
}

export interface SuspendRunResult {
  runId: string;
  microvmId: string;
  status: string;
  message: string;
}

export interface ResumeRunOptions extends CommonControlOptions {
  waitForState?: boolean;
  timeoutMs?: number;
}

export interface ResumeRunResult {
  runId: string;
  microvmId: string;
  status: string;
  message: string;
}

export interface FetchLogsOptions extends CommonControlOptions {
  limit?: number;
  startTime?: number;
  endTime?: number;
  filterPattern?: string;
  logGroupName?: string;
}

export interface LogEventItem {
  timestamp: number;
  message: string;
  logStreamName?: string;
  eventId?: string;
  formattedTime: string;
}

export interface FetchLogsResult {
  runId: string;
  logGroupName: string;
  events: LogEventItem[];
}

export interface CreatePrOptions extends CommonControlOptions {
  title?: string;
  body?: string;
}

export interface CreatePrResult {
  runId: string;
  prUrl?: string;
  workBranch: string;
  baseBranch: string;
  repoUrl: string;
  manualCommands?: string[];
  message: string;
}

export interface ShellSessionInfo {
  runId: string;
  microvmId: string;
  endpoint: string;
  wsUrl: string;
  subprotocols: string[];
  port: number;
  expiresAt: number;
}

/**
 * Loads a manifest from S3.
 */
async function loadManifest(
  s3Client: S3Client,
  bucket: string,
  runId: string,
): Promise<RunManifest> {
  const res = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: `runs/${runId}/manifest.json`,
    }),
  );
  const bodyStr = await res.Body?.transformToString();
  if (!bodyStr) {
    throw new Error(`Manifest for run '${runId}' is empty.`);
  }
  return RunManifestSchema.parse(JSON.parse(bodyStr));
}

/**
 * Saves an updated manifest back to S3.
 */
async function saveManifest(
  s3Client: S3Client,
  bucket: string,
  manifest: RunManifest,
): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `runs/${manifest.runId}/manifest.json`,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
    }),
  );
}

/**
 * Resolves default CloudWatch log group for runner MicroVMs.
 */
export function resolveLogGroupName(stackName: string, customGroupName?: string): string {
  if (customGroupName) return customGroupName;
  return `/aws/lambda/microvms/${stackName}-runner`;
}

/**
 * Stops and terminates a running cloud agent MicroVM.
 */
export async function stopCloudRun(
  queryRunId: string,
  options: StopRunOptions = {},
): Promise<StopRunResult> {
  const config = options.config || loadLocalConfig({ customDir: options.piAgentDir });
  const stackName = config.stackName || DEFAULT_STACK_NAME;
  const region = config.aws.region || "us-east-1";
  const profile = config.aws.profile;
  const factory = options.clientFactory || new AwsClientFactory({ region, profile });
  const s3Client = options.s3Client || factory.getS3Client({ region, profile });
  const microvmsClient =
    options.microvmsClient || factory.getLambdaMicrovmsClient({ region, profile });

  let bucket = options.bucket;
  if (!bucket) {
    bucket = await resolveBucketName(factory, stackName, region, profile);
  }
  if (!bucket) {
    throw new Error(`CloudFormation stack '${stackName}' bucket output not found.`);
  }

  const runId = await resolveRunId(s3Client, bucket, queryRunId);
  const manifest = await loadManifest(s3Client, bucket, runId);

  let checkpointSaved = false;

  // 1. If runner is actively running, attempt checkpoint to commit and save session
  if (
    !options.skipCheckpoint &&
    manifest.endpoint &&
    manifest.microvmId &&
    (manifest.status === "running" || manifest.status === "idle")
  ) {
    try {
      const runClient = new RunClient({
        endpoint: manifest.endpoint,
        microvmIdentifier: manifest.microvmId,
        region,
        profile,
        clientFactory: factory,
        microvmsClient,
        fetchFn: options.fetchFn,
      });

      await Promise.race([
        runClient.checkpoint(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      checkpointSaved = true;
    } catch {
      // Best effort checkpoint before termination
    }
  }

  // 2. Terminate the MicroVM if microvmId is present
  if (manifest.microvmId) {
    try {
      await microvmsClient.send(
        new TerminateMicrovmCommand({
          microvmIdentifier: manifest.microvmId,
        }),
      );
    } catch (err: unknown) {
      if (!options.force) {
        // If already terminated or not found, proceed
        const msg = (err as Error).message || "";
        if (!msg.includes("ResourceNotFoundException") && !msg.includes("not found")) {
          throw err;
        }
      }
    }
  }

  // 3. Update manifest status to terminated
  manifest.status = "terminated";
  manifest.updatedAt = new Date().toISOString();
  manifest.timeline.push({
    status: "terminated",
    at: new Date().toISOString(),
    reason: "User requested termination",
  });

  await saveManifest(s3Client, bucket, manifest);

  return {
    runId,
    microvmId: manifest.microvmId,
    status: "terminated",
    checkpointSaved,
    message: `Run '${runId}' terminated successfully.`,
  };
}

/**
 * Suspends an active cloud agent MicroVM.
 */
export async function suspendCloudRun(
  queryRunId: string,
  options: SuspendRunOptions = {},
): Promise<SuspendRunResult> {
  const config = options.config || loadLocalConfig({ customDir: options.piAgentDir });
  const stackName = config.stackName || DEFAULT_STACK_NAME;
  const region = config.aws.region || "us-east-1";
  const profile = config.aws.profile;
  const factory = options.clientFactory || new AwsClientFactory({ region, profile });
  const s3Client = options.s3Client || factory.getS3Client({ region, profile });
  const microvmsClient =
    options.microvmsClient || factory.getLambdaMicrovmsClient({ region, profile });

  let bucket = options.bucket;
  if (!bucket) {
    bucket = await resolveBucketName(factory, stackName, region, profile);
  }
  if (!bucket) {
    throw new Error(`CloudFormation stack '${stackName}' bucket output not found.`);
  }

  const runId = await resolveRunId(s3Client, bucket, queryRunId);
  const manifest = await loadManifest(s3Client, bucket, runId);

  if (!manifest.microvmId) {
    throw new Error(`Run '${runId}' has no associated MicroVM.`);
  }

  if (
    manifest.status === "completed" ||
    manifest.status === "failed" ||
    manifest.status === "terminated"
  ) {
    throw new Error(
      `Cannot suspend run '${runId}' because it is in terminal state '${manifest.status}'.`,
    );
  }

  // Call SuspendMicrovmCommand
  await microvmsClient.send(
    new SuspendMicrovmCommand({
      microvmIdentifier: manifest.microvmId,
    }),
  );

  // Poll for SUSPENDED state if requested
  const waitForState = options.waitForState !== false;
  if (waitForState) {
    const timeoutMs = options.timeoutMs ?? 30000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const vmRes = await microvmsClient.send(
          new GetMicrovmCommand({ microvmIdentifier: manifest.microvmId }),
        );
        const state = vmRes.state?.toUpperCase();
        if (state === "SUSPENDED") {
          break;
        }
      } catch {
        // Retry polling
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Update manifest status to suspended
  manifest.status = "suspended";
  manifest.updatedAt = new Date().toISOString();
  manifest.timeline.push({
    status: "suspended",
    at: new Date().toISOString(),
    reason: "User requested suspension",
  });

  await saveManifest(s3Client, bucket, manifest);

  return {
    runId,
    microvmId: manifest.microvmId,
    status: "suspended",
    message: `Run '${runId}' suspended successfully.`,
  };
}

/**
 * Resumes a suspended cloud agent MicroVM.
 */
export async function resumeCloudRun(
  queryRunId: string,
  options: ResumeRunOptions = {},
): Promise<ResumeRunResult> {
  const config = options.config || loadLocalConfig({ customDir: options.piAgentDir });
  const stackName = config.stackName || DEFAULT_STACK_NAME;
  const region = config.aws.region || "us-east-1";
  const profile = config.aws.profile;
  const factory = options.clientFactory || new AwsClientFactory({ region, profile });
  const s3Client = options.s3Client || factory.getS3Client({ region, profile });
  const microvmsClient =
    options.microvmsClient || factory.getLambdaMicrovmsClient({ region, profile });

  let bucket = options.bucket;
  if (!bucket) {
    bucket = await resolveBucketName(factory, stackName, region, profile);
  }
  if (!bucket) {
    throw new Error(`CloudFormation stack '${stackName}' bucket output not found.`);
  }

  const runId = await resolveRunId(s3Client, bucket, queryRunId);
  const manifest = await loadManifest(s3Client, bucket, runId);

  if (!manifest.microvmId) {
    throw new Error(`Run '${runId}' has no associated MicroVM.`);
  }

  if (
    manifest.status === "completed" ||
    manifest.status === "failed" ||
    manifest.status === "terminated"
  ) {
    throw new Error(
      `Cannot resume run '${runId}' because it is in terminal state '${manifest.status}'.`,
    );
  }

  // Call ResumeMicrovmCommand
  await microvmsClient.send(
    new ResumeMicrovmCommand({
      microvmIdentifier: manifest.microvmId,
    }),
  );

  // Poll for RUNNING state if requested
  const waitForState = options.waitForState !== false;
  if (waitForState) {
    const timeoutMs = options.timeoutMs ?? 30000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const vmRes = await microvmsClient.send(
          new GetMicrovmCommand({ microvmIdentifier: manifest.microvmId }),
        );
        const state = vmRes.state?.toUpperCase();
        if (state === "RUNNING") {
          break;
        }
      } catch {
        // Retry polling
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Update manifest status to running
  manifest.status = "running";
  manifest.updatedAt = new Date().toISOString();
  manifest.timeline.push({
    status: "running",
    at: new Date().toISOString(),
    reason: "User requested resume",
  });

  await saveManifest(s3Client, bucket, manifest);

  return {
    runId,
    microvmId: manifest.microvmId,
    status: "running",
    message: `Run '${runId}' resumed successfully.`,
  };
}

/**
 * Queries CloudWatch logs for a cloud agent run.
 */
export async function fetchCloudRunLogs(
  queryRunId: string,
  options: FetchLogsOptions = {},
): Promise<FetchLogsResult> {
  const config = options.config || loadLocalConfig({ customDir: options.piAgentDir });
  const stackName = config.stackName || DEFAULT_STACK_NAME;
  const region = config.aws.region || "us-east-1";
  const profile = config.aws.profile;
  const factory = options.clientFactory || new AwsClientFactory({ region, profile });
  const s3Client = options.s3Client || factory.getS3Client({ region, profile });
  const cwLogsClient = options.cwLogsClient || factory.getCloudWatchLogsClient({ region, profile });

  let bucket = options.bucket;
  if (!bucket) {
    bucket = await resolveBucketName(factory, stackName, region, profile);
  }

  const runId = bucket ? await resolveRunId(s3Client, bucket, queryRunId) : queryRunId;
  const logGroupName = resolveLogGroupName(stackName, options.logGroupName);
  const limit = options.limit ?? 100;

  const events: LogEventItem[] = [];

  try {
    const res = await cwLogsClient.send(
      new FilterLogEventsCommand({
        logGroupName,
        filterPattern: options.filterPattern || runId,
        startTime: options.startTime,
        endTime: options.endTime,
        limit,
      }),
    );

    for (const evt of res.events || []) {
      const ts = evt.timestamp ?? Date.now();
      events.push({
        timestamp: ts,
        message: evt.message || "",
        logStreamName: evt.logStreamName,
        eventId: evt.eventId,
        formattedTime: new Date(ts).toISOString().slice(11, 19),
      });
    }
  } catch (err: unknown) {
    throw new Error(`Failed to fetch logs from group '${logGroupName}': ${(err as Error).message}`);
  }

  return {
    runId,
    logGroupName,
    events,
  };
}

/**
 * Initiates live log tailing polling every intervalMs (default 2s).
 */
export function tailCloudRunLogs(
  runId: string,
  onEvent: (event: LogEventItem) => void,
  options: FetchLogsOptions & { pollIntervalMs?: number; signal?: AbortSignal } = {},
): () => void {
  let active = true;
  let lastTimestamp = options.startTime ?? Date.now() - 5 * 60 * 1000;
  const seenEventIds = new Set<string>();
  const intervalMs = options.pollIntervalMs ?? 2000;

  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      active = false;
    });
  }

  const poll = async () => {
    if (!active) return;
    try {
      const result = await fetchCloudRunLogs(runId, {
        ...options,
        startTime: lastTimestamp,
      });

      for (const evt of result.events) {
        if (evt.eventId && seenEventIds.has(evt.eventId)) continue;
        if (evt.eventId) seenEventIds.add(evt.eventId);
        if (evt.timestamp > lastTimestamp) {
          lastTimestamp = evt.timestamp;
        }
        onEvent(evt);
      }
    } catch {
      // Best effort log tailing
    }

    if (active) {
      setTimeout(poll, intervalMs);
    }
  };

  setTimeout(poll, 100);

  return () => {
    active = false;
  };
}

/**
 * Creates a GitHub Pull Request from the run's work branch or returns git push/gh commands.
 */
export async function createCloudRunPullRequest(
  queryRunId: string,
  options: CreatePrOptions = {},
): Promise<CreatePrResult> {
  const config = options.config || loadLocalConfig({ customDir: options.piAgentDir });
  const stackName = config.stackName || DEFAULT_STACK_NAME;
  const region = config.aws.region || "us-east-1";
  const profile = config.aws.profile;
  const factory = options.clientFactory || new AwsClientFactory({ region, profile });
  const s3Client = options.s3Client || factory.getS3Client({ region, profile });

  let bucket = options.bucket;
  if (!bucket) {
    bucket = await resolveBucketName(factory, stackName, region, profile);
  }
  if (!bucket) {
    throw new Error(`CloudFormation stack '${stackName}' bucket output not found.`);
  }

  const runId = await resolveRunId(s3Client, bucket, queryRunId);
  const manifest = await loadManifest(s3Client, bucket, runId);

  const workBranch = manifest.repo.workBranch;
  const baseBranch = manifest.repo.ref || "main";
  const repoUrl = manifest.repo.url;
  const prTitle = options.title || `Cloud agent changes for run ${runId}`;

  // 1. If manifest already has prUrl
  if (manifest.git?.prUrl) {
    return {
      runId,
      prUrl: manifest.git.prUrl,
      workBranch,
      baseBranch,
      repoUrl,
      message: `Pull request already exists: ${manifest.git.prUrl}`,
    };
  }

  // 2. If runner is actively running, attempt finalize call with createPr
  if (
    manifest.endpoint &&
    manifest.microvmId &&
    (manifest.status === "running" || manifest.status === "idle")
  ) {
    try {
      const runClient = new RunClient({
        endpoint: manifest.endpoint,
        microvmIdentifier: manifest.microvmId,
        region,
        profile,
        clientFactory: factory,
        fetchFn: options.fetchFn,
      });

      const res = await runClient.finalize({
        autoPush: true,
        commitMessage: prTitle,
      });

      if (res && typeof res === "object" && "prUrl" in res && typeof res.prUrl === "string") {
        return {
          runId,
          prUrl: res.prUrl,
          workBranch,
          baseBranch,
          repoUrl,
          message: `Pull request created successfully: ${res.prUrl}`,
        };
      }
    } catch {
      // Fall through to manual instructions
    }
  }

  // 3. Fallback: manual git and gh CLI commands
  const manualCommands = [
    `git fetch origin ${workBranch}`,
    `git push origin ${workBranch}`,
    `gh pr create --title "${prTitle}" --base ${baseBranch} --head ${workBranch}`,
  ];

  return {
    runId,
    workBranch,
    baseBranch,
    repoUrl,
    manualCommands,
    message: `Work branch is '${workBranch}'. Use GitHub CLI to create the pull request.`,
  };
}

/**
 * Creates an authorized shell session and WebSocket URL with port 8022.
 * Security rule: Shell auth token is never logged or written to disk.
 */
export async function createCloudRunShellSession(
  queryRunId: string,
  options: CommonControlOptions & { expirationMinutes?: number } = {},
): Promise<ShellSessionInfo> {
  const config = options.config || loadLocalConfig({ customDir: options.piAgentDir });
  const stackName = config.stackName || DEFAULT_STACK_NAME;
  const region = config.aws.region || "us-east-1";
  const profile = config.aws.profile;
  const factory = options.clientFactory || new AwsClientFactory({ region, profile });
  const s3Client = options.s3Client || factory.getS3Client({ region, profile });
  const microvmsClient =
    options.microvmsClient || factory.getLambdaMicrovmsClient({ region, profile });

  let bucket = options.bucket;
  if (!bucket) {
    bucket = await resolveBucketName(factory, stackName, region, profile);
  }
  if (!bucket) {
    throw new Error(`CloudFormation stack '${stackName}' bucket output not found.`);
  }

  const runId = await resolveRunId(s3Client, bucket, queryRunId);
  const manifest = await loadManifest(s3Client, bucket, runId);

  if (!manifest.microvmId || !manifest.endpoint) {
    throw new Error(`Run '${runId}' has no active MicroVM endpoint.`);
  }

  if (manifest.status === "terminated") {
    throw new Error(`Cannot open shell in terminated run '${runId}'.`);
  }

  const expirationMinutes = options.expirationMinutes ?? DEFAULT_SHELL_TOKEN_EXPIRATION_MINUTES;

  // Mint shell token scoped to port 8022 (expires in <= 15 min)
  const tokenRes = await microvmsClient.send(
    new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: manifest.microvmId,
      expirationInMinutes: expirationMinutes,
      allowedPorts: [{ port: SHELL_PORT }],
    }),
  );

  const tokenMap = tokenRes.authToken ?? {};
  const token =
    tokenMap["X-aws-proxy-auth"] || tokenMap["x-aws-proxy-auth"] || Object.values(tokenMap)[0];

  if (!token) {
    throw new Error("Failed to obtain shell auth token from CreateMicrovmAuthToken.");
  }

  const endpoint = manifest.endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const wsUrl = `wss://${endpoint}/shell`;

  const subprotocols = [
    "lambda-microvms",
    `lambda-microvms.authentication.${token}`,
    `lambda-microvms.port.${SHELL_PORT}`,
  ];

  return {
    runId,
    microvmId: manifest.microvmId,
    endpoint,
    wsUrl,
    subprotocols,
    port: SHELL_PORT,
    expiresAt: Date.now() + expirationMinutes * 60 * 1000,
  };
}
