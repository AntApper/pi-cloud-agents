/**
 * Observability and Diagnostics Bundle Exporter (T5.6).
 * Gathers manifest, /v1/status, GetMicrovm telemetry, and CloudWatch logs,
 * deeply sanitizes all secrets and account IDs, and exports diagnostic bundle.
 */

import fs from "node:fs";
import path from "node:path";
import { type CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { GetMicrovmCommand, type LambdaMicrovmsClient } from "@aws-sdk/client-lambda-microvms";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { LocalConfig } from "../shared/config.js";
import type { RunManifest } from "../shared/protocol.js";
import { AwsClientFactory } from "./aws/clients.js";
import { maskObject } from "./aws/mask.js";
import { loadLocalConfig } from "./config.js";
import { resolveBucketName } from "./list.js";
import { DEFAULT_STACK_NAME } from "./sync.js";

export interface CreateDiagnosticsBundleOptions {
  runId: string;
  config?: LocalConfig;
  s3Client?: S3Client;
  microvmsClient?: LambdaMicrovmsClient;
  cwClient?: CloudWatchLogsClient;
  clientFactory?: AwsClientFactory;
  piAgentDir?: string;
  outputDir?: string;
  maxLogLines?: number;
}

export interface DiagnosticsBundle {
  runId: string;
  exportedAt: string;
  manifest?: RunManifest;
  microvm?: Record<string, unknown>;
  logLines: string[];
  metricsSummary?: Record<string, unknown>;
}

/**
 * Gathers, sanitizes, and exports a diagnostics bundle for a given cloud run.
 */
export async function createDiagnosticsBundle(
  options: CreateDiagnosticsBundleOptions,
): Promise<{ bundle: DiagnosticsBundle; bundleFilePath: string }> {
  const { runId } = options;
  const config = options.config || loadLocalConfig({ customDir: options.piAgentDir });
  const stackName = config.stackName || DEFAULT_STACK_NAME;
  const region = config.aws.region || "us-east-1";
  const profile = config.aws.profile;
  const factory = options.clientFactory || new AwsClientFactory({ region, profile });

  const s3Client = options.s3Client || factory.getS3Client({ region, profile });
  const microvmsClient =
    options.microvmsClient || factory.getLambdaMicrovmsClient({ region, profile });
  const cwClient = options.cwClient || factory.getCloudWatchLogsClient({ region, profile });
  const bucket = await resolveBucketName(factory, stackName, region, profile);

  // 1. Fetch manifest
  let manifest: RunManifest | undefined;
  try {
    const res = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: `runs/${runId}/manifest.json`,
      }),
    );
    const raw = (await res.Body?.transformToString()) || "";
    manifest = JSON.parse(raw);
  } catch {}

  // 2. Fetch MicroVM info
  let microvmInfo: Record<string, unknown> | undefined;
  if (manifest?.microvmId) {
    try {
      const vmRes = await microvmsClient.send(
        new GetMicrovmCommand({
          microvmIdentifier: manifest.microvmId,
        }),
      );
      microvmInfo = {
        microvmId: vmRes.microvmId,
        state: vmRes.state,
        endpoint: vmRes.endpoint,
        imageArn: vmRes.imageArn,
        imageVersion: vmRes.imageVersion,
        executionRoleArn: vmRes.executionRoleArn,
      };
    } catch {}
  }

  // 3. Fetch CloudWatch logs
  const logLines: string[] = [];
  const maxLines = options.maxLogLines || 200;
  try {
    const logGroupName = `/aws/lambda/microvms/${config.image.name || `${stackName}-runner`}`;
    const logRes = await cwClient.send(
      new FilterLogEventsCommand({
        logGroupName,
        filterPattern: runId,
        limit: maxLines,
      }),
    );

    if (logRes.events) {
      for (const ev of logRes.events) {
        if (ev.message) {
          logLines.push(ev.message);
        }
      }
    }
  } catch {}

  // 4. Sanitize and redact all data
  const rawBundle: DiagnosticsBundle = {
    runId,
    exportedAt: new Date().toISOString(),
    manifest,
    microvm: microvmInfo,
    logLines,
    metricsSummary: manifest?.usage,
  };

  const sanitizedBundle = maskObject(rawBundle) as DiagnosticsBundle;

  // 5. Write to file
  const outDir = options.outputDir || path.join(process.cwd(), ".tmp");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const bundleFileName = `diag-${runId}.json`;
  const bundleFilePath = path.join(outDir, bundleFileName);
  fs.writeFileSync(bundleFilePath, JSON.stringify(sanitizedBundle, null, 2), {
    mode: 0o600,
    encoding: "utf-8",
  });

  return {
    bundle: sanitizedBundle,
    bundleFilePath,
  };
}
