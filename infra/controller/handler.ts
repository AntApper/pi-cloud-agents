import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  type MicrovmItem,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DeleteSecretCommand,
  ListSecretsCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

export interface ControllerDecision {
  microvmId: string;
  runId?: string;
  action: "keepalive" | "suspend" | "terminate" | "janitor_secret_cleanup" | "none";
  reason: string;
  details?: Record<string, unknown>;
}

export interface ControllerExecutionSummary {
  timestamp: string;
  stackName: string;
  imageName: string;
  region: string;
  dryRun: boolean;
  durationMs: number;
  runningCount: number;
  suspendedCount: number;
  terminatedCount: number;
  otherCount: number;
  decisions: ControllerDecision[];
  errors: Array<{ microvmId?: string; error: string }>;
}

export interface ControllerHealthState {
  consecutiveFailures: number;
  firstFailedAt: string;
  lastFailedAt: string;
}

export interface RunManifestInfo {
  v?: number;
  runId: string;
  status: string;
  updatedAt?: string;
  options?: {
    maxDurationSec?: number;
    idleGraceSec?: number;
    suspendAfterIdleSec?: number;
    terminateAfterSuspendedSec?: number;
  };
}

export interface StatusResponseData {
  status?: string;
  runId?: string;
  uptimeSeconds?: number;
  agentState?: string;
  idleSince?: string | null;
  suggestedAction?: "none" | "suspend" | "terminate";
  policy?: {
    idleGraceSec?: number;
    suspendAfterIdleSec?: number;
    terminateAfterSuspendedSec?: number;
    maxDurationSec?: number;
  };
}

export interface ControllerRunOptions {
  stackName?: string;
  bucketName?: string;
  imageName?: string;
  region?: string;
  dryRun?: boolean;
  microvmsClient?: LambdaMicrovmsClient;
  s3Client?: S3Client;
  secretsClient?: SecretsManagerClient;
  fetchFn?: typeof fetch;
  clock?: () => number;
  idleGraceSec?: number;
  finalizeGraceSec?: number;
  orphanGraceSec?: number;
  unhealthyThreshold?: number;
  unhealthyTerminateSec?: number;
}

const DEFAULT_IDLE_GRACE_SEC = 120; // 2 minutes
const DEFAULT_FINALIZE_GRACE_SEC = 600; // 10 minutes
const DEFAULT_ORPHAN_GRACE_SEC = 1200; // 20 minutes
const DEFAULT_MAX_DURATION_SEC = 28800; // 8 hours
const DEFAULT_MAX_DURATION_GRACE_SEC = 600; // 10 minutes
const DEFAULT_UNHEALTHY_THRESHOLD = 3; // 3 consecutive failed polls
const DEFAULT_UNHEALTHY_TERMINATE_SEC = 900; // 15 minutes

/**
 * Controller Lambda execution engine.
 * Implements 1-minute keepalive pings, outside idle suspension, lifecycle termination,
 * unhealthy detection, and janitor secret cleanup.
 */
export async function executeControllerRun(
  options: ControllerRunOptions = {},
): Promise<ControllerExecutionSummary> {
  const startTime = options.clock ? options.clock() : Date.now();
  const region =
    options.region ?? process.env.PI_CLOUD_REGION ?? process.env.AWS_REGION ?? "us-east-1";
  const stackName = options.stackName ?? process.env.PI_CLOUD_STACK ?? "pi-cloud-agents";
  const bucketName = options.bucketName ?? process.env.PI_CLOUD_BUCKET ?? "";
  const imageName =
    options.imageName ?? process.env.PI_CLOUD_IMAGE_NAME ?? "pi-cloud-agents-runner";
  const dryRun = options.dryRun ?? (process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1");

  const idleGraceSec = options.idleGraceSec ?? DEFAULT_IDLE_GRACE_SEC;
  const finalizeGraceSec = options.finalizeGraceSec ?? DEFAULT_FINALIZE_GRACE_SEC;
  const orphanGraceSec = options.orphanGraceSec ?? DEFAULT_ORPHAN_GRACE_SEC;
  const unhealthyThreshold = options.unhealthyThreshold ?? DEFAULT_UNHEALTHY_THRESHOLD;
  const unhealthyTerminateSec = options.unhealthyTerminateSec ?? DEFAULT_UNHEALTHY_TERMINATE_SEC;

  const microvmsClient = options.microvmsClient ?? new LambdaMicrovmsClient({ region });
  const s3Client = options.s3Client ?? new S3Client({ region });
  const secretsClient = options.secretsClient ?? new SecretsManagerClient({ region });
  const httpFetch = options.fetchFn ?? globalThis.fetch;
  const now = options.clock ? options.clock() : Date.now();

  const decisions: ControllerDecision[] = [];
  const errors: Array<{ microvmId?: string; error: string }> = [];

  let runningCount = 0;
  let suspendedCount = 0;
  let terminatedCount = 0;
  let otherCount = 0;

  // 1. List MicroVMs for target image
  const microvms: MicrovmItem[] = [];
  try {
    let nextToken: string | undefined;
    do {
      const listOutput = await microvmsClient.send(new ListMicrovmsCommand({ nextToken }));
      const items = (listOutput.items ?? []).filter((vm) => {
        if (!vm.imageArn) return true;
        return (
          vm.imageArn.includes(imageName) ||
          (vm.imageArn.includes(stackName) && vm.imageArn.includes("runner"))
        );
      });
      microvms.push(...items);
      nextToken = listOutput.nextToken;
    } while (nextToken);
  } catch (err: unknown) {
    const errorMsg = (err as Error)?.message || String(err);
    errors.push({ error: `Failed to list MicroVMs: ${errorMsg}` });
  }

  // 2. Process each MicroVM
  for (const vm of microvms) {
    const vmId = vm.microvmId;
    if (!vmId) continue;

    const vmState = vm.state ?? "UNKNOWN";

    if (vmState === "RUNNING") {
      runningCount++;
      try {
        await processRunningMicrovm({
          vmId,
          vm,
          imageName,
          stackName,
          bucketName,
          region,
          dryRun,
          microvmsClient,
          s3Client,
          httpFetch,
          now,
          idleGraceSec,
          finalizeGraceSec,
          orphanGraceSec,
          unhealthyThreshold,
          unhealthyTerminateSec,
          decisions,
          errors,
        });
      } catch (err: unknown) {
        const errorMsg = (err as Error)?.message || String(err);
        errors.push({ microvmId: vmId, error: `Error processing RUNNING MicroVM: ${errorMsg}` });
      }
    } else if (vmState === "SUSPENDED") {
      suspendedCount++;
      decisions.push({
        microvmId: vmId,
        action: "none",
        reason: "MicroVM is SUSPENDED (handled by platform idle auto-resume)",
      });
    } else if (vmState === "TERMINATED") {
      terminatedCount++;
      try {
        await processTerminatedMicrovm({
          vmId,
          stackName,
          bucketName,
          dryRun,
          s3Client,
          secretsClient,
          decisions,
          errors,
        });
      } catch (err: unknown) {
        const errorMsg = (err as Error)?.message || String(err);
        errors.push({
          microvmId: vmId,
          error: `Error running janitor cleanup for TERMINATED MicroVM: ${errorMsg}`,
        });
      }
    } else {
      otherCount++;
      decisions.push({
        microvmId: vmId,
        action: "none",
        reason: `MicroVM in transitional state '${vmState}'`,
      });
    }
  }

  const durationMs = (options.clock ? options.clock() : Date.now()) - startTime;
  const summary: ControllerExecutionSummary = {
    timestamp: new Date(now).toISOString(),
    stackName,
    imageName,
    region,
    dryRun,
    durationMs,
    runningCount,
    suspendedCount,
    terminatedCount,
    otherCount,
    decisions,
    errors,
  };

  // 3. Write execution summary to S3 (controller/last-run.json)
  if (bucketName && !dryRun) {
    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: "controller/last-run.json",
          Body: JSON.stringify(summary, null, 2),
          ContentType: "application/json",
        }),
      );
    } catch (err: unknown) {
      const errorMsg = (err as Error)?.message || String(err);
      errors.push({ error: `Failed to write controller/last-run.json: ${errorMsg}` });
    }
  }

  return summary;
}

interface ProcessRunningVmContext {
  vmId: string;
  vm: MicrovmItem;
  imageName: string;
  stackName: string;
  bucketName: string;
  region: string;
  dryRun: boolean;
  microvmsClient: LambdaMicrovmsClient;
  s3Client: S3Client;
  httpFetch: typeof fetch;
  now: number;
  idleGraceSec: number;
  finalizeGraceSec: number;
  orphanGraceSec: number;
  unhealthyThreshold: number;
  unhealthyTerminateSec: number;
  decisions: ControllerDecision[];
  errors: Array<{ microvmId?: string; error: string }>;
}

async function processRunningMicrovm(ctx: ProcessRunningVmContext): Promise<void> {
  // 1. Get MicroVM live details (endpoint, startedAt)
  let endpoint: string | undefined;
  let startedAt: Date | undefined = ctx.vm.startedAt;

  try {
    const desc = await ctx.microvmsClient.send(
      new GetMicrovmCommand({
        microvmIdentifier: ctx.vmId,
      }),
    );
    endpoint = desc.endpoint;
    startedAt = desc.startedAt ?? startedAt;
  } catch (err: unknown) {
    ctx.errors.push({
      microvmId: ctx.vmId,
      error: `Failed GetMicrovm for ${ctx.vmId}: ${(err as Error)?.message || String(err)}`,
    });
  }

  const vmAgeSec = startedAt ? (ctx.now - startedAt.getTime()) / 1000 : 0;

  // 2. Resolve runId from S3 index/
  let runId: string | undefined;
  if (ctx.bucketName) {
    try {
      const indexObj = await ctx.s3Client.send(
        new GetObjectCommand({
          Bucket: ctx.bucketName,
          Key: `index/${ctx.vmId}`,
        }),
      );
      const rawIndex = await indexObj.Body?.transformToString();
      if (rawIndex) {
        try {
          const parsed = JSON.parse(rawIndex);
          runId = parsed.runId || parsed;
        } catch {
          runId = rawIndex.trim();
        }
      }
    } catch (err: unknown) {
      const name = (err as Error)?.name || "";
      if (
        !(err instanceof NotFound) &&
        !(err instanceof NoSuchKey) &&
        name !== "NotFound" &&
        name !== "NoSuchKey" &&
        name !== "404"
      ) {
        ctx.errors.push({
          microvmId: ctx.vmId,
          error: `Failed to read index/${ctx.vmId}: ${(err as Error)?.message || String(err)}`,
        });
      }
    }
  }

  // 3. Resolve manifest if runId found
  let manifest: RunManifestInfo | undefined;
  if (ctx.bucketName && runId) {
    try {
      const manifestObj = await ctx.s3Client.send(
        new GetObjectCommand({
          Bucket: ctx.bucketName,
          Key: `runs/${runId}/manifest.json`,
        }),
      );
      const rawManifest = await manifestObj.Body?.transformToString();
      if (rawManifest) {
        manifest = JSON.parse(rawManifest) as RunManifestInfo;
      }
    } catch (err: unknown) {
      const name = (err as Error)?.name || "";
      if (
        !(err instanceof NotFound) &&
        !(err instanceof NoSuchKey) &&
        name !== "NotFound" &&
        name !== "NoSuchKey" &&
        name !== "404"
      ) {
        ctx.errors.push({
          microvmId: ctx.vmId,
          error: `Failed to read manifest for run '${runId}': ${(err as Error)?.message || String(err)}`,
        });
      }
    }
  }

  // 4. Evaluate orphan condition
  if (!manifest && vmAgeSec > ctx.orphanGraceSec) {
    ctx.decisions.push({
      microvmId: ctx.vmId,
      runId,
      action: "terminate",
      reason: `Orphaned MicroVM running without manifest for ${Math.round(vmAgeSec)}s (> ${ctx.orphanGraceSec}s grace)`,
    });
    if (!ctx.dryRun) {
      await ctx.microvmsClient.send(
        new TerminateMicrovmCommand({
          microvmIdentifier: ctx.vmId,
        }),
      );
    }
    return;
  }

  // 5. Evaluate maximum duration cap (hard 8-hour cap + grace)
  const maxDurationSec = manifest?.options?.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC;
  if (vmAgeSec > maxDurationSec + DEFAULT_MAX_DURATION_GRACE_SEC) {
    ctx.decisions.push({
      microvmId: ctx.vmId,
      runId,
      action: "terminate",
      reason: `MicroVM exceeded maximum duration (${Math.round(vmAgeSec)}s > ${maxDurationSec + DEFAULT_MAX_DURATION_GRACE_SEC}s)`,
    });
    if (!ctx.dryRun) {
      await ctx.microvmsClient.send(
        new TerminateMicrovmCommand({
          microvmIdentifier: ctx.vmId,
        }),
      );
    }
    return;
  }

  // 6. Evaluate terminal state grace period (completed/failed/terminated > 10 min)
  if (
    manifest &&
    (manifest.status === "completed" ||
      manifest.status === "failed" ||
      manifest.status === "finished" ||
      manifest.status === "terminated")
  ) {
    const updatedAt = manifest.updatedAt
      ? new Date(manifest.updatedAt).getTime()
      : (startedAt?.getTime() ?? ctx.now);
    const terminalAgeSec = (ctx.now - updatedAt) / 1000;

    if (terminalAgeSec > ctx.finalizeGraceSec) {
      ctx.decisions.push({
        microvmId: ctx.vmId,
        runId,
        action: "terminate",
        reason: `Run is in finished state '${manifest.status}' for ${Math.round(terminalAgeSec)}s (> ${ctx.finalizeGraceSec}s grace)`,
      });
      if (!ctx.dryRun) {
        await ctx.microvmsClient.send(
          new TerminateMicrovmCommand({
            microvmIdentifier: ctx.vmId,
          }),
        );
      }
      return;
    }
  }

  // 7. Make Keepalive HTTP Status Ping if endpoint is available
  if (!endpoint) {
    ctx.decisions.push({
      microvmId: ctx.vmId,
      runId,
      action: "none",
      reason: "MicroVM has no active endpoint assigned",
    });
    return;
  }

  let proxyAuthToken: string | undefined;
  try {
    const tokenOutput = await ctx.microvmsClient.send(
      new CreateMicrovmAuthTokenCommand({
        microvmIdentifier: ctx.vmId,
        expirationInMinutes: 5,
        allowedPorts: [{ port: 8080 }],
      }),
    );
    proxyAuthToken =
      tokenOutput.authToken?.["X-aws-proxy-auth"] || Object.values(tokenOutput.authToken ?? {})[0];
  } catch (err: unknown) {
    ctx.errors.push({
      microvmId: ctx.vmId,
      error: `Failed to create proxy auth token: ${(err as Error)?.message || String(err)}`,
    });
  }

  if (!proxyAuthToken) {
    return;
  }

  // Send keepalive GET /v1/status
  let statusResponseOk = false;
  let statusData: StatusResponseData | undefined;

  try {
    const cleanEndpoint = endpoint.replace(/^https?:\/\//, "");
    const statusUrl = `https://${cleanEndpoint}/v1/status`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const res = await ctx.httpFetch(statusUrl, {
      method: "GET",
      headers: {
        "X-aws-proxy-auth": proxyAuthToken,
        "X-aws-proxy-port": "8080",
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      statusResponseOk = true;
      statusData = (await res.json()) as StatusResponseData;
    } else {
      ctx.errors.push({
        microvmId: ctx.vmId,
        error: `HTTP /v1/status ping returned status ${res.status}`,
      });
    }
  } catch (err: unknown) {
    const errorMsg = (err as Error)?.message || String(err);
    ctx.errors.push({
      microvmId: ctx.vmId,
      error: `Keepalive HTTP ping failed for ${ctx.vmId}: ${errorMsg}`,
    });
  }

  // 8. Handle Health Tracking & Decision Evaluation
  if (statusResponseOk && statusData) {
    // Reset unhealthy tracking if previously set
    if (ctx.bucketName) {
      try {
        await ctx.s3Client.send(
          new DeleteObjectCommand({
            Bucket: ctx.bucketName,
            Key: `controller/health/${ctx.vmId}.json`,
          }),
        );
      } catch {
        // Ignore delete error
      }
    }

    const suggestedAction = statusData.suggestedAction;
    const idleSinceStr = statusData.idleSince;
    const agentState = statusData.agentState || statusData.status;

    if (suggestedAction === "suspend") {
      const idleGrace = statusData.policy?.idleGraceSec ?? ctx.idleGraceSec;
      const idleSinceTime = idleSinceStr ? new Date(idleSinceStr).getTime() : ctx.now;
      const idleDurationSec = (ctx.now - idleSinceTime) / 1000;

      if (idleDurationSec >= idleGrace) {
        ctx.decisions.push({
          microvmId: ctx.vmId,
          runId,
          action: "suspend",
          reason: `Agent idle for ${Math.round(idleDurationSec)}s (>= ${idleGrace}s grace)`,
          details: { suggestedAction, idleDurationSec, idleGrace },
        });

        if (!ctx.dryRun) {
          await suspendWithBackoff(ctx.microvmsClient, ctx.vmId);
        }
        return;
      }
    } else if (suggestedAction === "terminate") {
      ctx.decisions.push({
        microvmId: ctx.vmId,
        runId,
        action: "terminate",
        reason: "Runner lifecycle policy suggested termination",
        details: { suggestedAction },
      });

      if (!ctx.dryRun) {
        await ctx.microvmsClient.send(
          new TerminateMicrovmCommand({
            microvmIdentifier: ctx.vmId,
          }),
        );
      }
      return;
    }

    // Default healthy keepalive
    ctx.decisions.push({
      microvmId: ctx.vmId,
      runId,
      action: "keepalive",
      reason: `Keepalive ping successful (agentState: ${agentState}, suggestedAction: ${suggestedAction || "none"})`,
      details: { agentState, uptimeSeconds: statusData.uptimeSeconds },
    });
  } else {
    // Ping failed: increment unhealthy count
    let healthState: ControllerHealthState = {
      consecutiveFailures: 1,
      firstFailedAt: new Date(ctx.now).toISOString(),
      lastFailedAt: new Date(ctx.now).toISOString(),
    };

    if (ctx.bucketName) {
      try {
        const healthObj = await ctx.s3Client.send(
          new GetObjectCommand({
            Bucket: ctx.bucketName,
            Key: `controller/health/${ctx.vmId}.json`,
          }),
        );
        const raw = await healthObj.Body?.transformToString();
        if (raw) {
          const prev = JSON.parse(raw) as ControllerHealthState;
          healthState = {
            consecutiveFailures: (prev.consecutiveFailures || 0) + 1,
            firstFailedAt: prev.firstFailedAt || new Date(ctx.now).toISOString(),
            lastFailedAt: new Date(ctx.now).toISOString(),
          };
        }
      } catch {
        // First failure
      }

      if (!ctx.dryRun) {
        try {
          await ctx.s3Client.send(
            new PutObjectCommand({
              Bucket: ctx.bucketName,
              Key: `controller/health/${ctx.vmId}.json`,
              Body: JSON.stringify(healthState),
              ContentType: "application/json",
            }),
          );
        } catch {
          // Ignore health record write error
        }
      }
    }

    const firstFailedTime = new Date(healthState.firstFailedAt).getTime();
    const failureDurationSec = (ctx.now - firstFailedTime) / 1000;

    if (
      healthState.consecutiveFailures >= ctx.unhealthyThreshold &&
      failureDurationSec >= ctx.unhealthyTerminateSec
    ) {
      ctx.decisions.push({
        microvmId: ctx.vmId,
        runId,
        action: "terminate",
        reason: `MicroVM unreachable for ${healthState.consecutiveFailures} consecutive polls (${Math.round(failureDurationSec)}s > ${ctx.unhealthyTerminateSec}s)`,
        details: { consecutiveFailures: healthState.consecutiveFailures, failureDurationSec },
      });

      if (!ctx.dryRun) {
        await ctx.microvmsClient.send(
          new TerminateMicrovmCommand({
            microvmIdentifier: ctx.vmId,
          }),
        );
      }
    } else if (healthState.consecutiveFailures >= ctx.unhealthyThreshold) {
      ctx.decisions.push({
        microvmId: ctx.vmId,
        runId,
        action: "none",
        reason: `MicroVM unreachable (${healthState.consecutiveFailures} consecutive failed polls, marked unhealthy)`,
        details: { consecutiveFailures: healthState.consecutiveFailures, failureDurationSec },
      });
    } else {
      ctx.decisions.push({
        microvmId: ctx.vmId,
        runId,
        action: "none",
        reason: `Keepalive ping failed (${healthState.consecutiveFailures}/${ctx.unhealthyThreshold})`,
        details: { consecutiveFailures: healthState.consecutiveFailures },
      });
    }
  }
}

interface ProcessTerminatedVmContext {
  vmId: string;
  stackName: string;
  bucketName: string;
  dryRun: boolean;
  s3Client: S3Client;
  secretsClient: SecretsManagerClient;
  decisions: ControllerDecision[];
  errors: Array<{ microvmId?: string; error: string }>;
}

async function processTerminatedMicrovm(ctx: ProcessTerminatedVmContext): Promise<void> {
  // 1. Resolve runId from index
  let runId: string | undefined;
  if (ctx.bucketName) {
    try {
      const indexObj = await ctx.s3Client.send(
        new GetObjectCommand({
          Bucket: ctx.bucketName,
          Key: `index/${ctx.vmId}`,
        }),
      );
      const raw = await indexObj.Body?.transformToString();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          runId = parsed.runId || parsed;
        } catch {
          runId = raw.trim();
        }
      }
    } catch {
      // Index may not exist or already deleted
    }
  }

  // 2. Janitor: Delete run-scoped secrets for terminated run
  if (runId) {
    const runSecretPrefix = `pi-cloud-agents/${ctx.stackName}/runs/${runId}/`;
    try {
      let nextToken: string | undefined;
      const secretsToDelete: Array<{ Name?: string }> = [];
      do {
        const listOutput = await ctx.secretsClient.send(
          new ListSecretsCommand({
            NextToken: nextToken,
            Filters: [
              {
                Key: "name",
                Values: [runSecretPrefix],
              },
            ],
          }),
        );

        const filtered = (listOutput.SecretList ?? []).filter((s) =>
          s.Name?.startsWith(runSecretPrefix),
        );
        secretsToDelete.push(...filtered);
        nextToken = listOutput.NextToken;
      } while (nextToken);

      for (const secret of secretsToDelete) {
        if (!secret.Name) continue;
        if (!ctx.dryRun) {
          await ctx.secretsClient.send(
            new DeleteSecretCommand({
              SecretId: secret.Name,
              ForceDeleteWithoutRecovery: true,
            }),
          );
        }
      }

      if (secretsToDelete.length > 0) {
        ctx.decisions.push({
          microvmId: ctx.vmId,
          runId,
          action: "janitor_secret_cleanup",
          reason: `Force-deleted ${secretsToDelete.length} run-scoped secret(s) for terminated run '${runId}'`,
          details: { secretCount: secretsToDelete.length },
        });
      }
    } catch (err: unknown) {
      ctx.errors.push({
        microvmId: ctx.vmId,
        error: `Janitor failed to list/delete secrets for run '${runId}': ${(err as Error)?.message || String(err)}`,
      });
    }

    // Clean up health state if exists
    if (ctx.bucketName && !ctx.dryRun) {
      try {
        await ctx.s3Client.send(
          new DeleteObjectCommand({
            Bucket: ctx.bucketName,
            Key: `controller/health/${ctx.vmId}.json`,
          }),
        );
      } catch {
        // Ignore
      }
    }
  }
}

/**
 * Executes SuspendMicrovmCommand with rate-limiting and backoff to respect the 2 TPS quota.
 */
async function suspendWithBackoff(
  client: LambdaMicrovmsClient,
  microvmId: string,
  maxRetries = 3,
): Promise<void> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      await client.send(
        new SuspendMicrovmCommand({
          microvmIdentifier: microvmId,
        }),
      );
      return;
    } catch (err: unknown) {
      attempt++;
      const name = (err as Error)?.name || "";
      const isThrottled =
        name === "ThrottlingException" ||
        name === "TooManyRequestsException" ||
        name === "RequestLimitExceeded";

      if (isThrottled && attempt < maxRetries) {
        const delayMs = 500 * 2 ** (attempt - 1) + Math.random() * 200;
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Standard AWS Lambda handler export (EventBridge cron entrypoint).
 */
export const handler = async (
  _event: unknown,
  _context?: unknown,
): Promise<{ statusCode: number; body: string }> => {
  const summary = await executeControllerRun();
  console.log(JSON.stringify({ type: "controller_run_summary", ...summary }));
  return {
    statusCode: 200,
    body: JSON.stringify(summary),
  };
};
