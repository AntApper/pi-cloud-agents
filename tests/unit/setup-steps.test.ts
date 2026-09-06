import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLocalConfig } from "../../core/config.js";
import { ScriptedPrompter } from "../../core/prompter.js";
import {
  discoverAwsProfiles,
  discoverLocalProviderIds,
  formatSetupPlanTable,
  runSetupWizard,
} from "../../core/setup/steps.js";
import { handleCloudSetupCommand } from "../../extension/commands/setup.js";
import { DEFAULT_LOCAL_CONFIG, type LocalConfig } from "../../shared/config.js";

const stsMock = mockClient(STSClient);

describe("T4.3a Setup Wizard Step Machine & Prompter", () => {
  let tempDir: string;
  let prevAgentDir: string | undefined;
  let prevAwsProfile: string | undefined;

  beforeEach(() => {
    prevAgentDir = process.env.PI_AGENT_DIR;
    prevAwsProfile = process.env.AWS_PROFILE;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cloud-setup-test-"));
    process.env.PI_AGENT_DIR = tempDir;

    stsMock.reset();
    stsMock.on(GetCallerIdentityCommand).resolves({
      Account: "123456789012",
      Arn: "arn:aws:iam::123456789012:user/ant",
      UserId: "AIDA1234567890",
    });
  });

  afterEach(() => {
    process.env.PI_AGENT_DIR = prevAgentDir;
    process.env.AWS_PROFILE = prevAwsProfile;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("Discovery Helpers", () => {
    it("discovers default or configured AWS profiles", () => {
      process.env.AWS_PROFILE = "work-profile";
      const profiles = discoverAwsProfiles();
      expect(profiles).toContain("work-profile");
    });

    it("discovers local provider credentials categorizing api keys and oauth", () => {
      const authEntries = {
        anthropic: { type: "api_key" as const, key: "sk-ant-test" },
        "openai-codex": { type: "oauth" as const, refresh: "r", access: "a", expires: 1000 },
        bedrock: { type: "api_key" as const, key: "none" },
      };

      const disc = discoverLocalProviderIds({ authEntries });
      expect(disc.all).toEqual(["anthropic", "openai-codex", "bedrock"]);
      expect(disc.apiKeys).toEqual(["anthropic", "bedrock"]);
      expect(disc.oauth).toEqual(["openai-codex"]);
    });

    it("renders clean width-safe setup plan table without forbidden emojis", () => {
      const config: LocalConfig = {
        ...DEFAULT_LOCAL_CONFIG,
        aws: { region: "us-east-1", profile: "personal" },
        providers: {
          synced: ["anthropic", "openai"],
          oauthOptIn: ["anthropic"],
          bedrockRole: true,
        },
      };

      const table = formatSetupPlanTable(config, {
        accountId: "123456789012",
        arn: "arn:aws:iam::123456789012:user/ant",
      });
      expect(table).toContain("pi cloud agents · Setup Plan");
      expect(table).toContain("AWS Profile:        personal");
      expect(table).toContain("us-east-1");
      expect(table).toContain("anthropic, openai");
      expect(table).toContain("Estimated Idle Cost: $0.00 / month");

      const lines = table.split("\n");
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(76);
      }
    });
  });

  describe("Quick Setup Flow (Default)", () => {
    it("runs Quick Setup on 'create' action and saves default config", async () => {
      const prompter = new ScriptedPrompter({
        selectResponses: ["create"],
      });

      const authEntries = {
        anthropic: { type: "api_key" as const, key: "sk-ant-test" },
        openai: { type: "api_key" as const, key: "sk-proj-test" },
      };

      const result = await runSetupWizard({
        prompter,
        authEntries,
        defaultRegion: "us-east-1",
      });

      expect(result.success).toBe(true);
      expect(result.cancelled).toBeFalsy();
      expect(result.config.aws.region).toBe("us-east-1");
      expect(result.config.providers.synced).toEqual(["anthropic", "openai"]);
      expect(result.dryRun).toBe(false);

      // Verify saved to disk
      const saved = loadLocalConfig({ customDir: tempDir });
      expect(saved.aws.region).toBe("us-east-1");
      expect(saved.providers.synced).toEqual(["anthropic", "openai"]);
    });

    it("cancels cleanly when user selects 'cancel'", async () => {
      const prompter = new ScriptedPrompter({
        selectResponses: ["cancel"],
      });

      const result = await runSetupWizard({
        prompter,
      });

      expect(result.success).toBe(false);
      expect(result.cancelled).toBe(true);
    });

    it("generates plan without saving when dryRun is enabled", async () => {
      const prompter = new ScriptedPrompter({
        selectResponses: ["create"],
      });

      const result = await runSetupWizard({
        prompter,
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.planText).toContain("pi cloud agents · Setup Plan");

      // Verify NOT saved to disk
      const configPath = path.join(tempDir, "pi-cloud-agents.json");
      expect(fs.existsSync(configPath)).toBe(false);
    });
  });

  describe("Custom Wizard Flow", () => {
    it("navigates all custom steps, gates OAuth with ToS confirmation, and records PAT", async () => {
      const prompter = new ScriptedPrompter({
        selectResponses: [
          "customize", // Quick summary -> choose customize
          "default", // Step 1: Profile
          "us-west-2", // Step 1: Region
          "pat", // Step 3: GitHub PAT
        ],
        multiselectResponses: [
          ["anthropic", "openai-codex"], // Step 2: Providers
        ],
        confirmResponses: [
          true, // OAuth opt-in confirmation for openai-codex
          true, // Bedrock IAM role enabled
          true, // Final confirmation
        ],
        passwordResponses: [
          "github_pat_1234567890abcdef", // GitHub PAT
        ],
        inputResponses: [
          "6", // Max duration hours
          "20", // Idle suspend minutes
          "2", // Max concurrent runs
        ],
      });

      const authEntries = {
        anthropic: { type: "api_key" as const, key: "sk-ant" },
        "openai-codex": { type: "oauth" as const, refresh: "r", access: "a", expires: 1000 },
      };

      const result = await runSetupWizard({
        prompter,
        authEntries,
      });

      expect(result.success).toBe(true);
      expect(result.config.aws.region).toBe("us-west-2");
      expect(result.config.providers.synced).toEqual(["anthropic", "openai-codex"]);
      expect(result.config.providers.oauthOptIn).toEqual(["openai-codex"]);
      expect(result.config.providers.bedrockRole).toBe(true);
      expect(result.config.github.mode).toBe("secret");
      expect(result.config.defaults.maxDurationHours).toBe(6);
      expect(result.config.defaults.idle.suspendAfterMin).toBe(20);
      expect(result.config.defaults.maxConcurrent).toBe(2);
      expect(result.githubToken).toBe("github_pat_1234567890abcdef");

      // Verify saved to disk
      const saved = loadLocalConfig({ customDir: tempDir });
      expect(saved.defaults.maxDurationHours).toBe(6);
      expect(saved.providers.oauthOptIn).toEqual(["openai-codex"]);
    });

    it("strips OAuth provider from sync if user declines opt-in confirmation", async () => {
      const prompter = new ScriptedPrompter({
        selectResponses: ["customize", "default", "us-east-1", "skip"],
        multiselectResponses: [["anthropic", "openai-codex"]],
        confirmResponses: [
          false, // Decline OAuth opt-in for openai-codex
          false, // Bedrock false
          true, // Final confirmation
        ],
        inputResponses: ["4", "15", "3"],
      });

      const authEntries = {
        anthropic: { type: "api_key" as const, key: "sk-ant" },
        "openai-codex": { type: "oauth" as const, refresh: "r", access: "a", expires: 1000 },
      };

      const result = await runSetupWizard({
        prompter,
        authEntries,
      });

      expect(result.success).toBe(true);
      // openai-codex stripped because user declined OAuth opt-in
      expect(result.config.providers.synced).toEqual(["anthropic"]);
      expect(result.config.providers.oauthOptIn).toEqual([]);
    });
  });

  describe("handleCloudSetupCommand", () => {
    it("executes setup via extension router and outputs plan result", async () => {
      const notified: string[] = [];
      const res = await handleCloudSetupCommand(
        ["--dry-run"],
        {
          hasUI: true,
          ui: {
            notify: (msg) => notified.push(msg),
          },
        },
        {
          nonInteractive: true,
        },
      );

      expect(res.handled).toBe(true);
      expect(res.output).toContain("pi cloud agents · Setup Plan");
      expect(res.output).toContain("Plan preview generated (dry-run)");
      expect(notified).toHaveLength(1);
    });
  });
});
