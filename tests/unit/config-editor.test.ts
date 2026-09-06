import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatConfigView, getConfigValue, setConfigValue } from "../../core/config-editor.js";
import { loadLocalConfig, saveLocalConfig } from "../../core/config.js";
import { handleCloudConfigCommand } from "../../extension/commands/config.js";
import { DEFAULT_LOCAL_CONFIG, type LocalConfig } from "../../shared/config.js";

describe("T4.11 Config Editor & /cloud config", () => {
  let tempDir: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    prevAgentDir = process.env.PI_AGENT_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cloud-config-test-"));
    process.env.PI_AGENT_DIR = tempDir;
  });

  afterEach(() => {
    process.env.PI_AGENT_DIR = prevAgentDir;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("getConfigValue", () => {
    it("reads top-level and nested configuration properties correctly", () => {
      const config: LocalConfig = {
        ...DEFAULT_LOCAL_CONFIG,
        aws: { region: "us-west-2", profile: "work" },
        defaults: {
          ...DEFAULT_LOCAL_CONFIG.defaults,
          maxDurationHours: 6,
          idle: { suspendAfterMin: 20, terminateAfterSuspendedMin: 60 },
        },
        providers: {
          synced: ["anthropic", "openai"],
          oauthOptIn: ["anthropic"],
          bedrockRole: true,
        },
      };

      expect(getConfigValue(config, "aws.region")).toBe("us-west-2");
      expect(getConfigValue(config, "aws.profile")).toBe("work");
      expect(getConfigValue(config, "defaults.maxDurationHours")).toBe(6);
      expect(getConfigValue(config, "defaults.idle.suspendAfterMin")).toBe(20);
      expect(getConfigValue(config, "providers.synced")).toEqual(["anthropic", "openai"]);
      expect(getConfigValue(config, "providers.bedrockRole")).toBe(true);
      expect(getConfigValue(config, "non.existent.key")).toBeUndefined();
    });
  });

  describe("setConfigValue & Validation", () => {
    it("updates numeric fields with bounds enforcement", () => {
      const config = { ...DEFAULT_LOCAL_CONFIG };

      const res = setConfigValue(config, "defaults.maxDurationHours", "6");
      expect(res.newValue).toBe(6);
      expect(res.config.defaults.maxDurationHours).toBe(6);

      // Exceeds 8h hard max
      expect(() => setConfigValue(config, "defaults.maxDurationHours", "12")).toThrow(
        /exceeds maximum allowed/,
      );

      // Below 1h min
      expect(() => setConfigValue(config, "defaults.maxDurationHours", "0")).toThrow(
        /below minimum allowed/,
      );

      // Invalid number
      expect(() => setConfigValue(config, "defaults.maxDurationHours", "not-a-number")).toThrow(
        /Invalid number/,
      );
    });

    it("updates boolean fields from various truthy/falsy representations", () => {
      const config = { ...DEFAULT_LOCAL_CONFIG };

      expect(setConfigValue(config, "defaults.autoPush", "true").newValue).toBe(true);
      expect(setConfigValue(config, "defaults.autoPush", "false").newValue).toBe(false);
      expect(setConfigValue(config, "defaults.autoPush", "1").newValue).toBe(true);
      expect(setConfigValue(config, "defaults.autoPush", "0").newValue).toBe(false);
      expect(setConfigValue(config, "defaults.autoPush", "yes").newValue).toBe(true);
      expect(setConfigValue(config, "defaults.autoPush", "no").newValue).toBe(false);

      expect(() => setConfigValue(config, "defaults.autoPush", "maybe")).toThrow(
        /Invalid boolean value/,
      );
    });

    it("updates array fields from comma-separated strings or arrays", () => {
      const config = { ...DEFAULT_LOCAL_CONFIG };

      const res1 = setConfigValue(config, "providers.synced", "anthropic, openai, bedrock");
      expect(res1.newValue).toEqual(["anthropic", "openai", "bedrock"]);
      expect(res1.config.providers.synced).toEqual(["anthropic", "openai", "bedrock"]);

      const res2 = setConfigValue(config, "providers.synced", ["gemini", "groq"]);
      expect(res2.newValue).toEqual(["gemini", "groq"]);
    });

    it("validates supported AWS regions and throws on unsupported regions", () => {
      const config = { ...DEFAULT_LOCAL_CONFIG };

      const res = setConfigValue(config, "aws.region", "us-east-2");
      expect(res.newValue).toBe("us-east-2");
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0]).toContain("Region changed to 'us-east-2'");

      expect(() => setConfigValue(config, "aws.region", "af-south-1")).toThrow(
        /Unsupported AWS region/,
      );
    });

    it("produces appropriate migration warnings on critical configuration changes", () => {
      const config = { ...DEFAULT_LOCAL_CONFIG };

      const memRes = setConfigValue(config, "image.memoryMiB", "8192");
      expect(memRes.warnings).toHaveLength(1);
      expect(memRes.warnings[0]).toContain("Run '/cloud update' to rebuild the runner image");

      const provRes = setConfigValue(config, "providers.synced", "anthropic");
      expect(provRes.warnings).toHaveLength(1);
      expect(provRes.warnings[0]).toContain("Run '/cloud sync'");

      const profRes = setConfigValue(config, "aws.profile", "dev-account");
      expect(profRes.warnings).toHaveLength(1);
      expect(profRes.warnings[0]).toContain("AWS profile changed");
    });
  });

  describe("formatConfigView", () => {
    it("formats a width-safe table without forbidden emojis", () => {
      const config = { ...DEFAULT_LOCAL_CONFIG };
      const output = formatConfigView(config, 80);

      expect(output).toContain("pi cloud agents · Configuration");
      expect(output).toContain("[AWS]");
      expect(output).toContain("[Defaults]");
      expect(output).toContain("aws.region");
      expect(output).toContain("us-east-1");

      const lines = output.split("\n");
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(80);
      }
    });
  });

  describe("handleCloudConfigCommand", () => {
    it("handles /cloud config (no args) by returning full table view", async () => {
      saveLocalConfig(DEFAULT_LOCAL_CONFIG);

      const notified: string[] = [];
      const res = await handleCloudConfigCommand([], {
        hasUI: true,
        ui: {
          notify: (msg) => notified.push(msg),
        },
      });

      expect(res.handled).toBe(true);
      expect(res.output).toContain("pi cloud agents · Configuration");
      expect(notified).toHaveLength(1);
    });

    it("handles /cloud config <key> by returning specific field value and description", async () => {
      saveLocalConfig(DEFAULT_LOCAL_CONFIG);

      const res = await handleCloudConfigCommand(["defaults.maxDurationHours"]);
      expect(res.handled).toBe(true);
      expect(res.output).toContain("Config 'defaults.maxDurationHours': 4");
      expect(res.output).toContain("Description:");
    });

    it("handles /cloud config <key> <val> by updating, saving, and reporting warnings", async () => {
      saveLocalConfig(DEFAULT_LOCAL_CONFIG);

      const res = await handleCloudConfigCommand(["defaults.maxDurationHours", "7"]);
      expect(res.handled).toBe(true);
      expect(res.output).toContain("Updated 'defaults.maxDurationHours' to: 7 (was: 4)");

      // Check saved on disk
      const loaded = loadLocalConfig();
      expect(loaded.defaults.maxDurationHours).toBe(7);
    });

    it("handles invalid key or value gracefully with descriptive error", async () => {
      saveLocalConfig(DEFAULT_LOCAL_CONFIG);

      const res = await handleCloudConfigCommand(["unknown.key"]);
      expect(res.handled).toBe(true);
      expect(res.output).toContain("Unknown config key 'unknown.key'");

      const res2 = await handleCloudConfigCommand(["defaults.maxDurationHours", "99"]);
      expect(res2.handled).toBe(true);
      expect(res2.output).toContain("exceeds maximum allowed");
    });
  });
});
