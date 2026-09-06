/**
 * Unit tests for T2.2 Runner Secrets Provider, Storage Sink, and In-VM Pi Environment Assembly.
 * Tests SecretsProvider retrieval and missing secret error codes,
 * StorageSink object management, and assembleInVmPiEnvironment directory structure and file permissions.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBundle } from "../../core/pi-config.js";
import { createLogger } from "../../runner/logger.js";
import {
  assembleInVmPiEnvironment,
  getProviderIdFromSecretName,
  getProviderSecretName,
} from "../../runner/pi-config.js";
import { FakeSecretsProvider, SecretMissingError } from "../../runner/secrets.js";
import { FakeStorageSink, LocalStorageSink } from "../../runner/storage.js";
import { type LaunchPayload, ProtocolErrorCode } from "../../shared/protocol.js";

describe("T2.2 Runner Secrets & Storage Sinks", () => {
  describe("FakeSecretsProvider", () => {
    it("stores and retrieves secret values", async () => {
      const provider = new FakeSecretsProvider({
        "pi-cloud-agents/test/pi-auth/anthropic": JSON.stringify({ key: "sk-ant-12345" }),
      });

      const val = await provider.get("pi-cloud-agents/test/pi-auth/anthropic");
      expect(val).toBe(JSON.stringify({ key: "sk-ant-12345" }));

      provider.set("new-secret", "new-value");
      expect(await provider.get("new-secret")).toBe("new-value");
    });

    it("throws SecretMissingError when secret does not exist", async () => {
      const provider = new FakeSecretsProvider();

      await expect(provider.get("missing-key")).rejects.toThrow(SecretMissingError);
      try {
        await provider.get("missing-key");
      } catch (err) {
        expect(err).toBeInstanceOf(SecretMissingError);
        expect((err as SecretMissingError).code).toBe(ProtocolErrorCode.SECRET_MISSING);
        expect((err as SecretMissingError).secretName).toBe("missing-key");
      }
    });
  });

  describe("LocalStorageSink & FakeStorageSink", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-sink-test-"));
    });

    afterEach(() => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("persists and retrieves files with LocalStorageSink", async () => {
      const sink = new LocalStorageSink({ baseDir: tmpDir });
      const testBuffer = Buffer.from("hello world config data", "utf8");

      await sink.putObject("config/alice/bundle.tar", testBuffer);
      const retrieved = await sink.getObject("config/alice/bundle.tar");

      expect(retrieved.equals(testBuffer)).toBe(true);

      const files = await sink.listObjects("config/alice");
      expect(files).toContain("config/alice/bundle.tar");
    });

    it("operates in memory with FakeStorageSink", async () => {
      const sink = new FakeStorageSink();
      const testData = "test-string-data";

      await sink.putObject("manifests/run-1.json", testData);
      const retrieved = await sink.getObject("manifests/run-1.json");

      expect(retrieved.toString("utf8")).toBe(testData);

      const files = await sink.listObjects("manifests");
      expect(files).toContain("manifests/run-1.json");
    });

    it("throws descriptive error when object is not found", async () => {
      const sink = new FakeStorageSink();
      await expect(sink.getObject("does-not-exist")).rejects.toThrow(/not found/i);
    });
  });

  describe("Helper Functions", () => {
    it("resolves provider secret names properly", () => {
      expect(getProviderSecretName("core-stack", "anthropic")).toBe(
        "pi-cloud-agents/core-stack/pi-auth/anthropic",
      );
      expect(
        getProviderSecretName("core-stack", "pi-cloud-agents/custom-stack/pi-auth/openai"),
      ).toBe("pi-cloud-agents/custom-stack/pi-auth/openai");
      expect(
        getProviderSecretName(
          "core-stack",
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:custom",
        ),
      ).toBe("arn:aws:secretsmanager:us-east-1:123456789012:secret:custom");
    });

    it("extracts provider ID from secret name", () => {
      expect(getProviderIdFromSecretName("pi-cloud-agents/core-stack/pi-auth/anthropic")).toBe(
        "anthropic",
      );
      expect(getProviderIdFromSecretName("custom-provider")).toBe("custom-provider");
    });
  });
});

describe("T2.2 In-VM Pi Environment Assembly (assembleInVmPiEnvironment)", () => {
  let tmpWorkDir: string;
  let storageSink: FakeStorageSink;
  let secretsProvider: FakeSecretsProvider;
  let samplePayload: LaunchPayload;

  beforeEach(() => {
    tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-assembly-test-"));
    storageSink = new FakeStorageSink();
    secretsProvider = new FakeSecretsProvider();

    // 1. Build a valid test bundle
    const bundleResult = buildBundle({
      authEntries: {
        anthropic: { key: "sk-ant-live-key-12345" },
        openai: { key: "sk-openai-live-key-67890" },
      },
      modelsJson: {
        providers: [{ id: "custom", name: "Custom Provider" }],
      },
      settingsSubset: {
        defaultModel: "claude-sonnet-4",
      },
      agentsMd: "# In-VM Operating Guide\nFollow rules strictly.",
    });

    // 2. Put bundle archive in storage sink
    storageSink.putObject("config/alice/bundle.tar", bundleResult.bundleTar);

    // 3. Put secrets in SecretsProvider
    secretsProvider.set(
      "pi-cloud-agents/test-stack/pi-auth/anthropic",
      JSON.stringify({ key: "sk-ant-live-key-12345" }),
    );
    secretsProvider.set(
      "pi-cloud-agents/test-stack/pi-auth/openai",
      JSON.stringify({ key: "sk-openai-live-key-67890" }),
    );
    secretsProvider.set("pi-cloud-agents/test-stack/github/token", "ghp_test_github_token_99999");

    samplePayload = {
      v: 1,
      runId: "run-20260906-assemble01",
      owner: "arn:aws:iam::123456789012:user/alice",
      stack: {
        name: "test-stack",
        region: "us-east-1",
        bucket: "test-bucket",
      },
      repo: {
        url: "https://github.com/example/repo.git",
        ref: "main",
        workBranch: "pi-cloud/run-20260906-assemble01",
      },
      model: {
        provider: "anthropic",
        id: "claude-sonnet-4-20250514",
      },
      piConfig: {
        bundleKey: "config/alice/bundle.tar",
        authParams: ["anthropic", "openai"],
        bedrockRole: false,
      },
      github: {
        mode: "secret",
        name: "pi-cloud-agents/test-stack/github/token",
      },
      options: {
        installTimeoutSec: 180,
        trustProjectConfig: true,
        idleGraceSec: 60,
        suspendAfterIdleSec: 300,
        terminateAfterSuspendedSec: 3600,
        autoPush: true,
        maxDurationSec: 7200,
      },
      logGroup: "/aws/lambda/microvms/pi-cloud-agents-runner",
    };
  });

  afterEach(() => {
    if (fs.existsSync(tmpWorkDir)) {
      fs.rmSync(tmpWorkDir, { recursive: true, force: true });
    }
  });

  it("assembles complete .pi-agent directory with valid file permissions and environment", async () => {
    const logger = createLogger({ level: "debug" });

    const result = await assembleInVmPiEnvironment({
      payload: samplePayload,
      secretsProvider,
      storageSink,
      targetDir: tmpWorkDir,
      logger,
    });

    expect(result.piAgentDir).toBe(tmpWorkDir);
    expect(result.syncedProviders).toEqual(["anthropic", "openai"]);

    // Verify directory permissions mode 0700
    const dirStats = fs.statSync(tmpWorkDir);
    expect(dirStats.mode & 0o777).toBe(0o700);

    // Verify auth.json permissions mode 0600
    const authPath = path.join(tmpWorkDir, "auth.json");
    expect(fs.existsSync(authPath)).toBe(true);
    const authStats = fs.statSync(authPath);
    expect(authStats.mode & 0o777).toBe(0o600);

    // Verify auth.json contents
    const authContent = JSON.parse(fs.readFileSync(authPath, "utf8"));
    expect(authContent.anthropic).toEqual({ key: "sk-ant-live-key-12345" });
    expect(authContent.openai).toEqual({ key: "sk-openai-live-key-67890" });

    // Verify models.json, settings.json, AGENTS.md
    expect(fs.existsSync(path.join(tmpWorkDir, "models.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpWorkDir, "settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpWorkDir, "AGENTS.md"))).toBe(true);

    // Verify returned environment map
    expect(result.env.PI_CODING_AGENT_DIR).toBe(tmpWorkDir);
    expect(result.env.AWS_REGION).toBe("us-east-1");
    expect(result.env.GITHUB_TOKEN).toBe("ghp_test_github_token_99999");
    expect(result.env.GH_TOKEN).toBe("ghp_test_github_token_99999");
  });

  it("redacts assembled secrets in logger output", async () => {
    const logOutputs: string[] = [];
    const logger = createLogger({
      level: "info",
      sink: (_entry, rawJson) => logOutputs.push(rawJson),
    });

    await assembleInVmPiEnvironment({
      payload: samplePayload,
      secretsProvider,
      storageSink,
      targetDir: tmpWorkDir,
      logger,
    });

    logger.info("Executing with key: sk-ant-live-key-12345 and token ghp_test_github_token_99999");

    const combined = logOutputs.join("\n");
    expect(combined).not.toContain("sk-ant-live-key-12345");
    expect(combined).not.toContain("ghp_test_github_token_99999");
    expect(combined).toContain("[REDACTED]");
  });

  it("throws SecretMissingError when a required provider secret is missing", async () => {
    secretsProvider.delete("pi-cloud-agents/test-stack/pi-auth/openai");

    await expect(
      assembleInVmPiEnvironment({
        payload: samplePayload,
        secretsProvider,
        storageSink,
        targetDir: tmpWorkDir,
      }),
    ).rejects.toThrow(SecretMissingError);
  });

  it("throws SecretMissingError when GitHub secret is missing", async () => {
    secretsProvider.delete("pi-cloud-agents/test-stack/github/token");

    await expect(
      assembleInVmPiEnvironment({
        payload: samplePayload,
        secretsProvider,
        storageSink,
        targetDir: tmpWorkDir,
      }),
    ).rejects.toThrow(SecretMissingError);
  });

  it("throws INTERNAL_ERROR when bundle TAR is missing in storage", async () => {
    const invalidPayload: LaunchPayload = {
      ...samplePayload,
      piConfig: {
        ...samplePayload.piConfig,
        bundleKey: "nonexistent/bundle.tar",
      },
    };

    await expect(
      assembleInVmPiEnvironment({
        payload: invalidPayload,
        secretsProvider,
        storageSink,
        targetDir: tmpWorkDir,
      }),
    ).rejects.toThrow(/Failed to download config bundle/);
  });

  it("handles github mode 'none' without setting GITHUB_TOKEN in env", async () => {
    const payloadNoGh: LaunchPayload = {
      ...samplePayload,
      github: { mode: "none" },
    };

    const result = await assembleInVmPiEnvironment({
      payload: payloadNoGh,
      secretsProvider,
      storageSink,
      targetDir: tmpWorkDir,
    });

    expect(result.env.GITHUB_TOKEN).toBeUndefined();
    expect(result.env.GH_TOKEN).toBeUndefined();
  });
});
