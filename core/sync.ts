/**
 * pi Configuration and Credential Synchronization (T4.13).
 * Pure core module that builds the pi config bundle, uploads it to S3,
 * synchronizes API keys and opted-in OAuth credentials to AWS Secrets Manager,
 * and updates local configuration syncedAt timestamp.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { LocalConfig } from "../shared/config.js";
import { AwsClientFactory } from "./aws/clients.js";
import { AwsSecretsStore, formatPiAuthSecretName } from "./aws/secrets.js";
import { loadLocalConfig, saveLocalConfig } from "./config.js";
import { type StoredCredential, parseAuthJson, resolvePiAgentDir } from "./credentials.js";
import { type BuildBundleResult, buildBundle } from "./pi-config.js";

export const DEFAULT_STACK_NAME = "pi-cloud-agents";

export interface SyncOptions {
  localConfig?: LocalConfig;
  stackName?: string;
  bucketName?: string;
  clientFactory?: AwsClientFactory;
  s3Client?: S3Client;
  secretsStore?: AwsSecretsStore;
  piAgentDir?: string;
  authEntries?: Record<string, StoredCredential>;
  modelsJson?: unknown;
  settingsJson?: unknown;
  agentMdContent?: string;
}

export interface SyncResult {
  success: boolean;
  syncedAt: string;
  bucketName: string;
  bundleKey: string;
  bundleSha256: string;
  bundleBytes: number;
  syncedProviders: string[];
  oauthProviders: string[];
  warnings: string[];
}

/**
 * Resolves the S3 storage bucket name from options or CloudFormation stack outputs.
 */
async function resolveStorageBucket(
  stackName: string,
  factory: AwsClientFactory,
  config: LocalConfig,
  explicitBucket?: string,
): Promise<string> {
  if (explicitBucket) {
    return explicitBucket;
  }

  const cfnClient = factory.getCloudFormationClient({
    region: config.aws.region,
    profile: config.aws.profile,
  });

  try {
    const res = await cfnClient.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = res.Stacks?.[0];
    const bucketOutput = stack?.Outputs?.find(
      (o) =>
        o.OutputKey === "StorageBucketName" ||
        o.OutputKey === "BucketName" ||
        o.OutputKey === "S3BucketName",
    );

    if (bucketOutput?.OutputValue) {
      return bucketOutput.OutputValue;
    }
  } catch (err) {
    throw new Error(
      `Failed to resolve storage bucket for stack '${stackName}': ${(err as Error).message}. Ensure the core CloudFormation stack is deployed or specify bucketName explicitly.`,
    );
  }

  throw new Error(
    `CloudFormation stack '${stackName}' does not have a StorageBucketName output. Verify that the core stack deployment completed successfully.`,
  );
}

/**
 * Reads local pi agent files from ~/.pi/agent if not explicitly provided.
 */
function resolveLocalPiFiles(options: SyncOptions): {
  authEntries: Record<string, StoredCredential>;
  modelsJson?: string;
  settingsJson?: Record<string, unknown>;
  agentMd?: string;
} {
  const agentDir = resolvePiAgentDir(options.piAgentDir);

  let authEntries: Record<string, StoredCredential> = options.authEntries ?? {};
  if (!options.authEntries) {
    const authPath = path.join(agentDir, "auth.json");
    if (fs.existsSync(authPath)) {
      try {
        const raw = fs.readFileSync(authPath, "utf8");
        const parsed = parseAuthJson(raw);
        authEntries = parsed.credentials;
      } catch {
        // Ignore auth parsing error and proceed with empty map
      }
    }
  }

  let modelsJson: string | undefined;
  if (options.modelsJson) {
    modelsJson =
      typeof options.modelsJson === "object"
        ? JSON.stringify(options.modelsJson)
        : String(options.modelsJson);
  } else {
    const modelsPath = path.join(agentDir, "models.json");
    if (fs.existsSync(modelsPath)) {
      try {
        modelsJson = fs.readFileSync(modelsPath, "utf8");
      } catch {}
    }
  }

  let settingsJson: Record<string, unknown> | undefined = options.settingsJson as
    | Record<string, unknown>
    | undefined;
  if (!settingsJson) {
    const settingsPath = path.join(agentDir, "settings.json");
    if (fs.existsSync(settingsPath)) {
      try {
        const raw = fs.readFileSync(settingsPath, "utf8");
        settingsJson = JSON.parse(raw) as Record<string, unknown>;
      } catch {}
    }
  }

  let agentMd = options.agentMdContent;
  if (!agentMd) {
    const agentMdPath = path.join(agentDir, "AGENTS.md");
    if (fs.existsSync(agentMdPath)) {
      try {
        agentMd = fs.readFileSync(agentMdPath, "utf8");
      } catch {}
    }
  }

  return {
    authEntries,
    modelsJson,
    settingsJson,
    agentMd,
  };
}

/**
 * Performs full sync of pi configuration bundle and provider secrets to AWS.
 */
export async function syncPiConfig(options: SyncOptions = {}): Promise<SyncResult> {
  const config = options.localConfig ?? loadLocalConfig();
  const stackName = options.stackName ?? config.stackName ?? DEFAULT_STACK_NAME;
  const factory = options.clientFactory ?? new AwsClientFactory();

  const { authEntries, modelsJson, settingsJson, agentMd } = resolveLocalPiFiles(options);

  // 1. Build bundle tar and extract secrets to sync
  const bundleResult: BuildBundleResult = buildBundle({
    authEntries,
    modelsJson,
    settingsSubset: settingsJson,
    agentsMd: agentMd,
    localConfig: config,
    stackName,
  });

  const sha256 = crypto.createHash("sha256").update(bundleResult.bundleTar).digest("hex");
  const bundleBytes = bundleResult.bundleTar.length;

  // 2. Resolve S3 bucket name
  const bucketName = await resolveStorageBucket(stackName, factory, config, options.bucketName);

  // 3. Upload bundle TAR to S3
  const s3Client =
    options.s3Client ??
    factory.getS3Client({
      region: config.aws.region,
      profile: config.aws.profile,
    });

  const bundleShaShort = sha256.slice(0, 16);
  const versionedKey = `config/bundle-${bundleShaShort}.tar`;
  const latestKey = "config/bundle.tar";

  // Upload versioned bundle
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: versionedKey,
      Body: bundleResult.bundleTar,
      ContentType: "application/x-tar",
      ServerSideEncryption: "AES256",
    }),
  );

  // Upload latest pointer bundle
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: latestKey,
      Body: bundleResult.bundleTar,
      ContentType: "application/x-tar",
      ServerSideEncryption: "AES256",
    }),
  );

  // 4. Sync provider credentials to AWS Secrets Manager
  const secretsStore =
    options.secretsStore ??
    new AwsSecretsStore({
      client: factory.getSecretsManagerClient({
        region: config.aws.region,
        profile: config.aws.profile,
      }),
    });

  const syncedProviders: string[] = [];
  const oauthProviders: string[] = [];

  for (const [provider, secretJson] of bundleResult.secrets.entries()) {
    const secretName = formatPiAuthSecretName(stackName, provider);
    await secretsStore.putSecret(secretName, secretJson, {
      description: `pi cloud agent synced credential for ${provider}`,
      tags: {
        "pi-cloud-agents:stack": stackName,
        "pi-cloud-agents:provider": provider,
      },
    });

    syncedProviders.push(provider);
    if (config.providers.oauthOptIn.includes(provider)) {
      oauthProviders.push(provider);
    }
  }

  // 5. Update LocalConfig syncedAt timestamp
  const nowIso = new Date().toISOString();
  const updatedConfig: LocalConfig = {
    ...config,
    providers: {
      ...config.providers,
      syncedAt: nowIso,
    },
  };
  saveLocalConfig(updatedConfig);

  return {
    success: true,
    syncedAt: nowIso,
    bucketName,
    bundleKey: versionedKey,
    bundleSha256: sha256,
    bundleBytes,
    syncedProviders,
    oauthProviders,
    warnings: bundleResult.manifest.warnings ?? [],
  };
}
