/**
 * Session Importer for Native Read-Only Session Viewer (T4.12).
 * Downloads remote session.jsonl from S3 or runner, rewrites headers with local placeholders,
 * persists to local session directory, and switches the active session into read-only mode.
 */

import fs from "node:fs";
import path from "node:path";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { LocalConfig } from "../shared/config.js";
import { AwsClientFactory } from "./aws/clients.js";
import { loadLocalConfig, resolvePiAgentDir } from "./config.js";
import { resolveBucketName } from "./list.js";
import { DEFAULT_STACK_NAME } from "./sync.js";

export interface ImportSessionOptions {
  runId: string;
  config?: LocalConfig;
  s3Client?: S3Client;
  clientFactory?: AwsClientFactory;
  piAgentDir?: string;
  sessionsDir?: string;
  targetDir?: string;
}

export interface ImportSessionResult {
  runId: string;
  sessionFilePath: string;
  entryCount: number;
  readOnly: boolean;
  byteSize: number;
}

/**
 * Rewrites remote session.jsonl content to make it compatible with local viewing:
 * - Updates cwd to local placeholder / target directory
 * - Injects cloud-run metadata markers
 */
export function rewriteSessionForLocalViewing(
  rawJsonl: string,
  runId: string,
  localTargetDir = process.cwd(),
): { rewrittenJsonl: string; entryCount: number } {
  const lines = rawJsonl.split("\n").filter((l) => l.trim().length > 0);
  const rewrittenLines: string[] = [];
  let entryCount = 0;

  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]!);
      entryCount++;

      // If header entry (first record / type: "session" or has "cwd")
      if (i === 0 || parsed.type === "session" || parsed.cwd) {
        parsed.cwd = localTargetDir;
        parsed.cloudRunId = runId;
        parsed.readOnly = true;
        parsed.importedAt = new Date().toISOString();
      }

      rewrittenLines.push(JSON.stringify(parsed));
    } catch {
      // If line is not JSON, preserve as-is
      rewrittenLines.push(lines[i]!);
    }
  }

  return {
    rewrittenJsonl: `${rewrittenLines.join("\n")}\n`,
    entryCount,
  };
}

/**
 * Downloads remote session transcript from S3 and imports it into the local pi sessions directory.
 */
export async function importRemoteSession(
  options: ImportSessionOptions,
): Promise<ImportSessionResult> {
  const { runId } = options;
  const config = options.config || loadLocalConfig({ customDir: options.piAgentDir });
  const stackName = config.stackName || DEFAULT_STACK_NAME;
  const region = config.aws.region || "us-east-1";
  const profile = config.aws.profile;
  const factory = options.clientFactory || new AwsClientFactory({ region, profile });
  const s3Client = options.s3Client || factory.getS3Client({ region, profile });

  const piDir = resolvePiAgentDir(options.piAgentDir);
  const sessionsDir = options.sessionsDir || path.join(piDir, "sessions");
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  }

  const bucket = await resolveBucketName(factory, stackName, region, profile);
  const s3Key = `runs/${runId}/session.jsonl`;

  let rawContent = "";
  try {
    const res = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: s3Key,
      }),
    );
    rawContent = (await res.Body?.transformToString()) || "";
  } catch (err: unknown) {
    throw new Error(
      `Failed to download session transcript for run '${runId}' from s3://${bucket}/${s3Key}: ${(err as Error).message}`,
    );
  }

  if (!rawContent.trim()) {
    throw new Error(`Session transcript for run '${runId}' is empty.`);
  }

  const { rewrittenJsonl, entryCount } = rewriteSessionForLocalViewing(
    rawContent,
    runId,
    options.targetDir || process.cwd(),
  );

  const localFileName = `cloud-${runId}.jsonl`;
  const sessionFilePath = path.join(sessionsDir, localFileName);
  fs.writeFileSync(sessionFilePath, rewrittenJsonl, { mode: 0o600, encoding: "utf-8" });

  const byteSize = Buffer.byteLength(rewrittenJsonl, "utf-8");

  return {
    runId,
    sessionFilePath,
    entryCount,
    readOnly: true,
    byteSize,
  };
}
