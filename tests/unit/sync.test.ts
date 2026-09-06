import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CreateSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLocalConfig, saveLocalConfig } from "../../core/config.js";
import { syncPiConfig } from "../../core/sync.js";
import { handleCloudSyncCommand } from "../../extension/commands/sync.js";
import { DEFAULT_LOCAL_CONFIG, type LocalConfig } from "../../shared/config.js";

const cfnMock = mockClient(CloudFormationClient);
const s3Mock = mockClient(S3Client);
const smMock = mockClient(SecretsManagerClient);

describe("T4.13 Cloud Sync (pi config bundle & credentials)", () => {
  let tempDir: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    prevAgentDir = process.env.PI_AGENT_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cloud-sync-test-"));
    process.env.PI_AGENT_DIR = tempDir;

    cfnMock.reset();
    s3Mock.reset();
    smMock.reset();

    cfnMock.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackName: "pi-cloud-agents",
          CreationTime: new Date(),
          StackStatus: "CREATE_COMPLETE",
          Outputs: [
            {
              OutputKey: "StorageBucketName",
              OutputValue: "test-pi-cloud-bucket-12345",
            },
          ],
        },
      ],
    });

    s3Mock.on(PutObjectCommand).resolves({});
    smMock
      .on(CreateSecretCommand)
      .resolves({ ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:test" });
  });

  afterEach(() => {
    process.env.PI_AGENT_DIR = prevAgentDir;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("builds bundle, uploads to S3, syncs secrets to Secrets Manager, and updates syncedAt", async () => {
    const config: LocalConfig = {
      ...DEFAULT_LOCAL_CONFIG,
      providers: {
        synced: ["anthropic", "openai"],
        oauthOptIn: ["anthropic"],
        bedrockRole: false,
      },
    };
    saveLocalConfig(config);

    const authEntries = {
      anthropic: {
        type: "api_key" as const,
        key: "sk-ant-test-key-123",
      },
      openai: {
        type: "api_key" as const,
        key: "sk-proj-test-key-456",
      },
      gemini: {
        type: "api_key" as const,
        key: "gemini-ignored-not-synced",
      },
    };

    const result = await syncPiConfig({
      authEntries,
    });

    expect(result.success).toBe(true);
    expect(result.bucketName).toBe("test-pi-cloud-bucket-12345");
    expect(result.syncedProviders).toEqual(["anthropic", "openai"]);
    expect(result.bundleBytes).toBeGreaterThan(0);
    expect(result.bundleKey).toMatch(/^config\/bundle-[a-f0-9]{16}\.tar$/);

    // Verify S3 uploads (versioned key and latest pointer)
    const s3Calls = s3Mock.commandCalls(PutObjectCommand);
    expect(s3Calls).toHaveLength(2);
    expect(s3Calls[0]?.args[0].input.Bucket).toBe("test-pi-cloud-bucket-12345");
    expect(s3Calls[0]?.args[0].input.Key).toBe(result.bundleKey);
    expect(s3Calls[1]?.args[0].input.Key).toBe("config/bundle.tar");

    // Verify Secrets Manager calls
    const smCalls = smMock.commandCalls(CreateSecretCommand);
    expect(smCalls).toHaveLength(2);
    const secretNames = smCalls.map((c) => c.args[0].input.Name);
    expect(secretNames).toContain("pi-cloud-agents/pi-cloud-agents/pi-auth/anthropic");
    expect(secretNames).toContain("pi-cloud-agents/pi-cloud-agents/pi-auth/openai");

    // Verify local config updated with syncedAt timestamp
    const savedConfig = loadLocalConfig();
    expect(savedConfig.providers.syncedAt).toBeDefined();
    expect(savedConfig.providers.syncedAt).toBe(result.syncedAt);
  });

  it("gates OAuth sync based on oauthOptIn list", async () => {
    const config: LocalConfig = {
      ...DEFAULT_LOCAL_CONFIG,
      providers: {
        synced: ["anthropic", "openai-codex"],
        oauthOptIn: [], // No OAuth opt-in
        bedrockRole: false,
      },
    };
    saveLocalConfig(config);

    const authEntries = {
      anthropic: {
        type: "api_key" as const,
        key: "sk-ant-test",
      },
      "openai-codex": {
        type: "oauth" as const,
        refresh: "refresh-token-xyz",
        access: "access-token-abc",
        expires: Date.now() + 3600000,
      },
    };

    const result = await syncPiConfig({
      authEntries,
    });

    expect(result.success).toBe(true);
    // openai-codex is OAuth but not in oauthOptIn -> stripped from sync
    expect(result.syncedProviders).toEqual(["anthropic"]);
    expect(result.oauthProviders).toEqual([]);

    const smCalls = smMock.commandCalls(CreateSecretCommand);
    expect(smCalls).toHaveLength(1);
    expect(smCalls[0]?.args[0].input.Name).toBe(
      "pi-cloud-agents/pi-cloud-agents/pi-auth/anthropic",
    );
  });

  it("handles /cloud sync command via extension router and outputs summary table", async () => {
    const config: LocalConfig = {
      ...DEFAULT_LOCAL_CONFIG,
      providers: {
        synced: ["anthropic"],
        oauthOptIn: [],
        bedrockRole: false,
      },
    };
    saveLocalConfig(config);

    const notified: string[] = [];
    const res = await handleCloudSyncCommand(
      [],
      {
        hasUI: true,
        ui: {
          notify: (msg) => notified.push(msg),
        },
      },
      {
        authEntries: {
          anthropic: { type: "api_key", key: "sk-test" },
        },
      },
    );

    expect(res.handled).toBe(true);
    expect(res.output).toContain("pi cloud agents · Sync Complete");
    expect(res.output).toContain("test-pi-cloud-bucket-12345");
    expect(res.output).toContain("anthropic");
    expect(notified).toHaveLength(1);
  });
});
