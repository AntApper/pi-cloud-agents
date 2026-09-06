import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  getLocalConfigPath,
  getRepoConfigPath,
  loadLocalConfig,
  loadRepoConfig,
  saveLocalConfig,
  saveRepoConfig,
} from "../../core/config.js";
import { resolvePiAgentDir } from "../../core/credentials.js";
import {
  DEFAULT_LOCAL_CONFIG,
  type LocalConfig,
  LocalConfigSchema,
  REPO_SECRET_NAME_REGEX,
  type RepoConfig,
  RepoConfigSchema,
} from "../../shared/config.js";

describe("T1.2 Configuration Schemas & Loader", () => {
  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cloud-config-test-"));
    originalEnv = process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PI_CODING_AGENT_DIR = originalEnv;
    } else {
      // biome-ignore lint/performance/noDelete: Environment variables must be deleted to be unset in Node.js
      delete process.env.PI_CODING_AGENT_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("LocalConfigSchema", () => {
    it("applies complete default configuration when parsed with empty object", () => {
      const config = LocalConfigSchema.parse({});
      expect(config).toEqual(DEFAULT_LOCAL_CONFIG);
      expect(config.aws.region).toBe("us-east-1");
      expect(config.stackName).toBe("pi-cloud-agents-core");
      expect(config.image.name).toBe("pi-cloud-agents-runner");
      expect(config.image.memoryMiB).toBe(4096);
      expect(config.defaults.maxDurationHours).toBe(4);
      expect(config.defaults.idle.suspendAfterMin).toBe(15);
      expect(config.defaults.idle.terminateAfterSuspendedMin).toBe(120);
      expect(config.defaults.maxConcurrent).toBe(3);
      expect(config.defaults.archiveRetentionDays).toBe(30);
      expect(config.defaults.controllerCadenceMin).toBe(1);
      expect(config.defaults.model).toEqual({
        provider: "anthropic",
        id: "claude-sonnet-4-6",
      });
      expect(config.providers.synced).toEqual([]);
      expect(config.providers.oauthOptIn).toEqual([]);
      expect(config.providers.bedrockRole).toBe(false);
      expect(config.github.mode).toBe("none");
    });

    it("preserves explicit overrides across all fields", () => {
      const input: LocalConfig = {
        aws: {
          profile: "my-aws-profile",
          region: "us-west-2",
        },
        stackName: "custom-cloud-stack",
        image: {
          name: "custom-runner-img",
          memoryMiB: 8192,
        },
        defaults: {
          model: {
            provider: "openai",
            id: "gpt-5-turbo",
          },
          maxDurationHours: 8,
          idle: {
            suspendAfterMin: 30,
            terminateAfterSuspendedMin: 240,
          },
          maxConcurrent: 5,
          archiveRetentionDays: 60,
          controllerCadenceMin: 2,
        },
        providers: {
          synced: ["anthropic", "openai"],
          oauthOptIn: ["anthropic"],
          bedrockRole: true,
          syncedAt: "2026-09-06T12:00:00.000Z",
        },
        github: {
          mode: "secret",
          secretName: "/pi-cloud-agents/custom-cloud-stack/github-token",
        },
        kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/test-key-id",
        egressConnectorArn: "arn:aws:lambda:us-west-2:123456789012:connector/test-conn",
      };

      const parsed = LocalConfigSchema.parse(input);
      expect(parsed).toEqual(input);
    });

    it("rejects maxDurationHours exceeding 8 hours hard cap", () => {
      expect(() =>
        LocalConfigSchema.parse({
          defaults: {
            maxDurationHours: 9,
          },
        }),
      ).toThrow();
    });

    it("rejects invalid values (negative numbers, empty strings)", () => {
      expect(() =>
        LocalConfigSchema.parse({
          stackName: "",
        }),
      ).toThrow();

      expect(() =>
        LocalConfigSchema.parse({
          image: { memoryMiB: -1024 },
        }),
      ).toThrow();

      expect(() =>
        LocalConfigSchema.parse({
          defaults: { maxConcurrent: 0 },
        }),
      ).toThrow();
    });
  });

  describe("RepoConfigSchema & Secret Name Validation", () => {
    it("validates REPO_SECRET_NAME_REGEX pattern", () => {
      // Valid stack-scoped paths
      expect(REPO_SECRET_NAME_REGEX.test("/pi-cloud-agents/core/my-secret")).toBe(true);
      expect(REPO_SECRET_NAME_REGEX.test("/pi-cloud-agents/stack-1/keys/anthropic")).toBe(true);
      expect(REPO_SECRET_NAME_REGEX.test("/pi-cloud-agents/prod.stack/api-token")).toBe(true);

      // Valid relative secret names
      expect(REPO_SECRET_NAME_REGEX.test("my-secret")).toBe(true);
      expect(REPO_SECRET_NAME_REGEX.test("github_pat_key")).toBe(true);
      expect(REPO_SECRET_NAME_REGEX.test("service.auth.v1")).toBe(true);

      // Invalid secret names
      expect(REPO_SECRET_NAME_REGEX.test("/invalid/prefix/secret")).toBe(false);
      expect(REPO_SECRET_NAME_REGEX.test("../../secret")).toBe(false);
      expect(
        REPO_SECRET_NAME_REGEX.test("arn:aws:secretsmanager:us-east-1:123456789012:secret:foo"),
      ).toBe(false);
      expect(REPO_SECRET_NAME_REGEX.test("secret with spaces")).toBe(false);
      expect(REPO_SECRET_NAME_REGEX.test("")).toBe(false);
    });

    it("validates a complete repo config", () => {
      const valid: RepoConfig = {
        install: "npm ci",
        start: "npm test",
        env: {
          NODE_ENV: "production",
          CI: "true",
        },
        secrets: ["/pi-cloud-agents/core/db-pass", "api-token"],
        model: {
          provider: "anthropic",
          id: "claude-sonnet-4-6",
        },
        memoryMiB: 4096,
      };

      const parsed = RepoConfigSchema.parse(valid);
      expect(parsed).toEqual(valid);
    });

    it("rejects invalid secrets in RepoConfig", () => {
      expect(() =>
        RepoConfigSchema.parse({
          secrets: ["/unauthorized/path/secret"],
        }),
      ).toThrow(/Secret name must be a relative identifier/);

      expect(() =>
        RepoConfigSchema.parse({
          secrets: ["../traversal"],
        }),
      ).toThrow(/Secret name must be a relative identifier/);
    });
  });

  describe("Config Loader & Directory Resolution", () => {
    it("resolves directory priority: customDir > env > homedir", () => {
      const homedir = os.homedir();
      expect(resolvePiAgentDir()).toBe(path.join(homedir, ".pi", "agent"));

      process.env.PI_CODING_AGENT_DIR = "/custom/env/dir";
      expect(resolvePiAgentDir()).toBe(path.resolve("/custom/env/dir"));

      expect(resolvePiAgentDir("/override/dir")).toBe(path.resolve("/override/dir"));
    });

    it("computes local and repo config paths", () => {
      const localPath = getLocalConfigPath(tempDir);
      expect(localPath).toBe(path.join(tempDir, "pi-cloud-agents.json"));

      const repoPath = getRepoConfigPath(tempDir);
      expect(repoPath).toBe(path.join(tempDir, ".pi", "cloud-agents.json"));
    });

    it("returns default config when local config does not exist", () => {
      const config = loadLocalConfig({ customDir: tempDir });
      expect(config).toEqual(DEFAULT_LOCAL_CONFIG);
    });

    it("saves and loads local configuration with file mode 0600", () => {
      const customConfig: LocalConfig = {
        ...DEFAULT_LOCAL_CONFIG,
        stackName: "my-tested-stack",
        defaults: {
          ...DEFAULT_LOCAL_CONFIG.defaults,
          maxDurationHours: 6,
        },
      };

      saveLocalConfig(customConfig, { customDir: tempDir });

      const configPath = getLocalConfigPath(tempDir);
      expect(fs.existsSync(configPath)).toBe(true);

      const stats = fs.statSync(configPath);
      // Verify file permissions 0600 (read/write by user only) on POSIX
      if (process.platform !== "win32") {
        const mode = stats.mode & 0o777;
        expect(mode).toBe(0o600);
      }

      const loaded = loadLocalConfig({ customDir: tempDir });
      expect(loaded.stackName).toBe("my-tested-stack");
      expect(loaded.defaults.maxDurationHours).toBe(6);
    });

    it("throws human-readable ConfigError on corrupt JSON syntax with line and col", () => {
      const configPath = getLocalConfigPath(tempDir);
      fs.writeFileSync(configPath, '{\n  "stackName": "invalid-json",\n  "broken": \n}', "utf8");

      expect(() => loadLocalConfig({ customDir: tempDir })).toThrow(ConfigError);

      try {
        loadLocalConfig({ customDir: tempDir });
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        const configErr = err as ConfigError;
        expect(configErr.message).toContain("Invalid JSON");
        expect(configErr.message).toContain("pi-cloud-agents.json");
        expect(configErr.line).toBeDefined();
      }
    });

    it("throws human-readable ConfigError on schema validation errors with field names", () => {
      const configPath = getLocalConfigPath(tempDir);
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          stackName: "",
          defaults: {
            maxDurationHours: 20, // > 8
          },
        }),
        "utf8",
      );

      try {
        loadLocalConfig({ customDir: tempDir });
        expect.unreachable("Should have thrown ConfigError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        const configErr = err as ConfigError;
        expect(configErr.message).toContain("Configuration validation failed");
        expect(configErr.message).toContain('Field "stackName"');
        expect(configErr.message).toContain('Field "defaults.maxDurationHours"');
      }
    });

    it("loads and saves repo configuration", () => {
      // Missing returns null
      expect(loadRepoConfig(tempDir)).toBeNull();

      const repoConfig: RepoConfig = {
        install: "npm ci",
        start: "npm run start:prod",
        secrets: ["api-key"],
      };

      saveRepoConfig(repoConfig, tempDir);

      const loaded = loadRepoConfig(tempDir);
      expect(loaded).toEqual(repoConfig);
    });
  });
});
