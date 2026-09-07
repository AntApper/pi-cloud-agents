/**
 * Cloud Runs Listing & Telemetry Merger (T4.6).
 * Reads S3 manifests, merges with active MicroVM state and /v1/status summaries,
 * calculates cost estimates from memory and runtime, and formats width-safe tables per §2.2.
 */

import { DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { type LambdaMicrovmsClient, ListMicrovmsCommand } from "@aws-sdk/client-lambda-microvms";
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import type { LocalConfig } from "../shared/config.js";
import { type RunManifest, RunManifestSchema, type RunnerStatus } from "../shared/protocol.js";
import { AwsClientFactory } from "./aws/clients.js";
import { collectPages } from "./aws/paginate.js";
import { RunClient } from "./client/run-client.js";
import { loadLocalConfig } from "./config.js";
import { DEFAULT_STACK_NAME } from "./sync.js";

// Standard AWS Lambda MicroVM pricing rates (us-east-1 ARM64 baseline)
export const VCPU_RATE_PER_SEC = 0.0000276944; // $0.0000276944 / vCPU-second
export const MEM_RATE_PER_SEC = 0.0000036667; // $0.0000036667 / GB-second
export const DEFAULT_BASELINE_MEMORY_MIB = 4096; // 4 GB default

export interface ActiveMicrovmInfo {
  microvmId?: string;
  state?: string;
  endpoint?: string;
  [key: string]: unknown;
}

export interface CostCalculationOptions {
  vCpuRate?: number;
  memRate?: number;
  tokenCostUsd?: number;
}

export interface CostEstimate {
  computeCostUsd: number;
  tokenCostUsd: number;
  totalCostUsd: number;
  formatted: string;
}

/**
 * Calculates estimated MicroVM execution cost and total cost.
 */
export function calculateMicrovmCost(
  memoryMiB: number,
  runningSeconds: number,
  options: CostCalculationOptions = {},
): CostEstimate {
  const vCpuRate = options.vCpuRate ?? VCPU_RATE_PER_SEC;
  const memRate = options.memRate ?? MEM_RATE_PER_SEC;
  const tokenCostUsd = options.tokenCostUsd ?? 0;

  const validMemMiB = Math.max(512, memoryMiB || DEFAULT_BASELINE_MEMORY_MIB);
  const vCpus = Math.max(1, Math.round(validMemMiB / 2048));
  const memoryGb = validMemMiB / 1024;
  const durationSec = Math.max(0, runningSeconds);

  const perSecRate = vCpus * vCpuRate + memoryGb * memRate;
  const computeCostUsd = perSecRate * durationSec;
  const totalCostUsd = computeCostUsd + tokenCostUsd;

  const dec = totalCostUsd < 0.1 && totalCostUsd > 0 ? 4 : 2;
  const formatted = `$${totalCostUsd.toFixed(dec)} est.`;

  return {
    computeCostUsd,
    tokenCostUsd,
    totalCostUsd,
    formatted,
  };
}

export interface ListRunsOptions {
  config?: LocalConfig;
  s3Client?: S3Client;
  microvmsClient?: LambdaMicrovmsClient;
  clientFactory?: AwsClientFactory;
  bucket?: string;
  limit?: number;
  fetchLiveStatus?: boolean;
  activeMicrovms?: ActiveMicrovmInfo[];
  fetchFn?: typeof fetch;
  piAgentDir?: string;
}

export interface RunListItem extends Record<string, unknown> {
  runId: string;
  fullRunId: string;
  status: string;
  statusBadge: string;
  repo: string;
  workBranch: string;
  model: string;
  activity: string;
  turns: number;
  tokens: string;
  tokensCount: number;
  cost: string;
  costUsd: number;
  elapsed: string;
  elapsedMs: number;
  lastEventAge: string;
  lastEventAgeSeconds: number;
  microvmId?: string;
  endpoint?: string;
  createdAt: string;
  updatedAt: string;
  manifest: RunManifest;
  liveStatus?: RunnerStatus;
}

/**
 * Extracts a concise human-readable short run identifier.
 * e.g. 'run-20260906-7f3a2c' -> '7f3a2c', 'run-abc111' -> 'abc111'
 */
export function extractShortRunId(runId: string): string {
  const clean = runId.replace(/^run-/, "");
  const parts = clean.split("-");
  if (parts.length >= 2 && /^\d{8}$/.test(parts[0]!)) {
    return parts.slice(1).join("-").slice(0, 8);
  }
  return clean.slice(0, 8);
}

/**
 * Formats a short repository display string: owner/repo#ref.
 */
export function formatRepoRef(url: string, ref?: string): string {
  if (!url) return "-";
  let clean = url.replace(/^https?:\/\//, "").replace(/\.git$/, "");
  if (clean.startsWith("github.com/")) {
    clean = clean.replace("github.com/", "");
  }
  return ref ? `${clean}#${ref}` : clean;
}

/**
 * Formats token count into compact string: 184k, 2.1M, etc.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens <= 0) return "0";
  if (tokens < 1000) return String(tokens);
  if (tokens < 1000000) {
    const k = tokens / 1000;
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  const m = tokens / 1000000;
  return `${m.toFixed(1)}M`;
}

/**
 * Formats elapsed duration into compact readable string: 12s, 42m, 2h 15m.
 */
export function formatElapsed(ms: number): string {
  if (ms <= 0) return "0s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) {
    return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  }
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

/**
 * Formats relative age: 1s ago, 4m ago, 2h ago.
 */
export function formatRelativeAge(seconds: number): string {
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s ago`;
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

/**
 * Resolves the S3 bucket name from CloudFormation stack output or config.
 */
export async function resolveBucketName(
  clientFactory: AwsClientFactory,
  stackName: string,
  region?: string,
  profile?: string,
): Promise<string> {
  const cfnClient = clientFactory.getCloudFormationClient({ region, profile });
  try {
    const res = await cfnClient.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = res.Stacks?.[0];
    const bucketOutput = stack?.Outputs?.find((o) => o.OutputKey === "BucketName");
    if (bucketOutput?.OutputValue) {
      return bucketOutput.OutputValue;
    }
  } catch {
    // Stack might not exist yet
  }
  return "";
}

/**
 * Lists all cloud agent runs by merging S3 manifests with active MicroVM state.
 */
export async function listCloudRuns(options: ListRunsOptions = {}): Promise<RunListItem[]> {
  const config = options.config || loadLocalConfig({ customDir: options.piAgentDir });
  const stackName = config.stackName || DEFAULT_STACK_NAME;
  const region = config.aws.region || "us-east-1";
  const profile = config.aws.profile;
  const factory = options.clientFactory || new AwsClientFactory({ region, profile });
  const s3Client = options.s3Client || factory.getS3Client({ region, profile });
  const microvmsClient =
    options.microvmsClient || factory.getLambdaMicrovmsClient({ region, profile });
  const limit = options.limit ?? 50;

  // 1. Resolve S3 bucket
  let bucket = options.bucket;
  if (!bucket) {
    bucket = await resolveBucketName(factory, stackName, region, profile);
  }
  if (!bucket) {
    return [];
  }

  // 2. Discover S3 manifest keys under runs/
  const manifestKeys: string[] = [];
  try {
    const objects = await collectPages({
      fetchPage: (ContinuationToken: string | undefined) =>
        s3Client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: "runs/", ContinuationToken }),
        ),
      nextToken: (page) => (page.IsTruncated ? page.NextContinuationToken : undefined),
      items: (page) => page.Contents,
    });
    for (const obj of objects) {
      if (obj.Key?.endsWith("/manifest.json")) {
        manifestKeys.push(obj.Key);
      }
    }
  } catch {
    return [];
  }

  if (manifestKeys.length === 0) {
    return [];
  }

  // 3. Fetch manifest documents (parallel pool)
  const rawManifests: RunManifest[] = [];
  await Promise.all(
    manifestKeys.map(async (key) => {
      try {
        const getRes = await s3Client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
        );
        const bodyStr = await getRes.Body?.transformToString();
        if (bodyStr) {
          const parsed = JSON.parse(bodyStr);
          const manifest = RunManifestSchema.parse(parsed);
          rawManifests.push(manifest);
        }
      } catch {
        // Skip invalid manifest
      }
    }),
  );

  // 4. Sort newest first by updatedAt / createdAt
  rawManifests.sort((a, b) => {
    const timeA = new Date(a.updatedAt || a.createdAt).getTime();
    const timeB = new Date(b.updatedAt || b.createdAt).getTime();
    return timeB - timeA;
  });

  const selectedManifests = rawManifests.slice(0, limit);

  // 5. Query active MicroVMs in account/region
  const activeVmMap = new Map<string, ActiveMicrovmInfo>();
  if (options.activeMicrovms) {
    for (const vm of options.activeMicrovms) {
      if (vm.microvmId) activeVmMap.set(vm.microvmId, vm);
    }
  } else {
    try {
      const vms = await collectPages({
        fetchPage: (nextToken: string | undefined) =>
          microvmsClient.send(new ListMicrovmsCommand({ nextToken })),
        nextToken: (page) => page.nextToken,
        items: (page) => page.items,
      });
      for (const vm of vms) {
        if (vm.microvmId) {
          activeVmMap.set(vm.microvmId, {
            microvmId: vm.microvmId,
            state: vm.state,
          });
        }
      }
    } catch {
      // Best effort active VM listing
    }
  }

  // 6. Assemble RunListItems with live telemetry merging
  const now = Date.now();
  const items: RunListItem[] = [];

  for (const manifest of selectedManifests) {
    const microvmId = manifest.microvmId;
    const activeVm = microvmId ? activeVmMap.get(microvmId) : undefined;
    const vmState = activeVm?.state?.toLowerCase();

    let effectiveStatus: string = manifest.status;
    if (
      effectiveStatus !== "completed" &&
      effectiveStatus !== "failed" &&
      effectiveStatus !== "terminated"
    ) {
      if (vmState === "suspended") {
        effectiveStatus = "suspended";
      } else if (vmState === "running" && effectiveStatus === "suspended") {
        effectiveStatus = "running";
      }
    }

    let liveStatus: RunnerStatus | undefined;
    let lastEventAgeSeconds = Math.max(
      0,
      Math.floor((now - new Date(manifest.updatedAt || manifest.createdAt).getTime()) / 1000),
    );

    // If VM is actively running and live status fetching is enabled
    if (
      options.fetchLiveStatus !== false &&
      manifest.endpoint &&
      microvmId &&
      (effectiveStatus === "running" || effectiveStatus === "idle")
    ) {
      try {
        const runClient = new RunClient({
          endpoint: manifest.endpoint,
          microvmIdentifier: microvmId,
          region,
          profile,
          clientFactory: factory,
          microvmsClient,
          fetchFn: options.fetchFn,
        });

        const statusRes = await Promise.race([
          runClient.getStatus(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);

        if (statusRes) {
          liveStatus = statusRes;
          effectiveStatus = statusRes.status || effectiveStatus;
          if (statusRes.lastActivityAt) {
            lastEventAgeSeconds = Math.max(
              0,
              Math.floor((now - new Date(statusRes.lastActivityAt).getTime()) / 1000),
            );
          }
        }
      } catch {
        // Fall back to manifest telemetry
      }
    }

    // Determine activity string
    let activity = effectiveStatus;
    if (effectiveStatus === "running") {
      activity = "running";
    } else if (effectiveStatus === "idle") {
      activity = `idle ${formatElapsed(lastEventAgeSeconds * 1000)}`;
    } else if (effectiveStatus === "suspended") {
      activity = `suspended ${formatElapsed(lastEventAgeSeconds * 1000)}`;
    } else if (effectiveStatus === "completed") {
      activity = "completed";
    } else if (effectiveStatus === "failed") {
      activity = "failed";
    } else if (effectiveStatus === "terminated") {
      activity = "terminated";
    }

    // Compute elapsed duration
    const createdTime = new Date(manifest.createdAt).getTime();
    const updatedTime = new Date(manifest.updatedAt || manifest.createdAt).getTime();
    const isFinished =
      effectiveStatus === "completed" ||
      effectiveStatus === "failed" ||
      effectiveStatus === "terminated";
    const elapsedMs = isFinished ? updatedTime - createdTime : now - createdTime;

    // Tokens and turns
    const tokensCount = manifest.usage?.totalTokens ?? 0;
    const tokensFormatted = formatTokenCount(tokensCount);
    const turns = manifest.timeline?.filter((t) => t.status === "running").length || 1;

    // Cost estimate
    const memoryMiB = config.image.memoryMiB || DEFAULT_BASELINE_MEMORY_MIB;
    const runningSeconds = Math.floor(elapsedMs / 1000);
    const costEstimate = calculateMicrovmCost(memoryMiB, runningSeconds, {
      tokenCostUsd: manifest.usage?.estimatedCostUsd ?? 0,
    });

    // Glyphs and short runId
    const shortRunId = extractShortRunId(manifest.runId);

    items.push({
      runId: shortRunId,
      fullRunId: manifest.runId,
      status: effectiveStatus,
      statusBadge: formatStatusBadge(effectiveStatus),
      repo: formatRepoRef(manifest.repo.url, manifest.repo.ref || "main"),
      workBranch: manifest.repo.workBranch,
      model: `${manifest.model.provider}/${manifest.model.id}`
        .replace("anthropic/", "")
        .replace("openai/", ""),
      activity,
      turns,
      tokens: tokensFormatted,
      tokensCount,
      cost: costEstimate.formatted,
      costUsd: costEstimate.totalCostUsd,
      elapsed: formatElapsed(elapsedMs),
      elapsedMs,
      lastEventAge: formatRelativeAge(lastEventAgeSeconds),
      lastEventAgeSeconds,
      microvmId: manifest.microvmId,
      endpoint: manifest.endpoint,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      manifest,
      liveStatus,
    });
  }

  return items;
}

/**
 * Formats a status badge: glyph + status label.
 */
export function formatStatusBadge(status: string): string {
  const norm = status.toLowerCase();
  switch (norm) {
    case "running":
      return "● running";
    case "idle":
      return "○ idle";
    case "suspended":
      return "◌ suspended";
    case "launching":
    case "provisioning":
      return "◐ launching";
    case "completed":
      return "✓ completed";
    case "failed":
    case "error":
      return "▲ failed";
    case "terminated":
      return "· terminated";
    default:
      return `· ${norm}`;
  }
}
