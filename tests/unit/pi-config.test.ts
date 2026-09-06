import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_SETTINGS_KEYS,
  assemblePiAgentDir,
  buildBundle,
  createDeterministicTar,
  extractTar,
  sanitizeSettings,
} from "../../core/pi-config.js";
import { DEFAULT_LOCAL_CONFIG } from "../../shared/config.js";

describe("T1.4 pi config bundle builder (core/pi-config)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cloud-bundle-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Deterministic TAR creation and extraction", () => {
    it("creates reproducible TAR archives with sorted entries and fixed timestamps", () => {
      const entries = [
        { name: "settings.json", content: '{"defaultModel":"claude"}\n' },
        { name: "models.json", content: '{"providers":[]}\n' },
        { name: "AGENTS.md", content: "# Agent Rules\n" },
      ];

      const tar1 = createDeterministicTar(entries);
      const tar2 = createDeterministicTar(entries.reverse());

      expect(tar1.length).toBe(tar2.length);
      expect(tar1.equals(tar2)).toBe(true);
    });

    it("extracts TAR archive faithfully restoring files and directories", () => {
      const entries = [
        { name: "models.json", content: '{"version":1}\n' },
        { name: "skills/test-skill/SKILL.md", content: "# Skill Doc\n" },
      ];

      const tar = createDeterministicTar(entries);
      const destDir = path.join(tempDir, "extracted");
      const extracted = extractTar(tar, destDir);

      expect(extracted.length).toBe(2);
      expect(fs.existsSync(path.join(destDir, "models.json"))).toBe(true);
      expect(fs.readFileSync(path.join(destDir, "models.json"), "utf8")).toBe('{"version":1}\n');

      expect(fs.existsSync(path.join(destDir, "skills", "test-skill", "SKILL.md"))).toBe(true);
      expect(fs.readFileSync(path.join(destDir, "skills", "test-skill", "SKILL.md"), "utf8")).toBe(
        "# Skill Doc\n",
      );
    });
  });

  describe("Settings Sanitization", () => {
    it("retains only allowed settings and strips disallowed paths/packages/extensions", () => {
      const rawSettings = {
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
        defaultThinkingLevel: "high",
        compaction: { enabled: true },
        retry: { maxAttempts: 3 },
        thinkingBudgets: { "claude-sonnet-4-6": 16000 },
        // Disallowed local settings
        packages: ["/local/custom/package"],
        extensions: ["/Users/ant/local-ext.ts"],
        customLocalPath: "/private/tmp",
        theme: "dark",
      };

      const sanitized = sanitizeSettings(rawSettings);

      expect(Object.keys(sanitized).sort()).toEqual(Array.from(ALLOWED_SETTINGS_KEYS).sort());
      expect(sanitized.defaultProvider).toBe("anthropic");
      expect(sanitized.defaultModel).toBe("claude-sonnet-4-6");
      expect((sanitized as Record<string, unknown>).packages).toBeUndefined();
      expect((sanitized as Record<string, unknown>).extensions).toBeUndefined();
      expect((sanitized as Record<string, unknown>).customLocalPath).toBeUndefined();
    });
  });

  describe("buildBundle & Provider Filtering", () => {
    const mockAuthEntries = {
      google: {
        type: "api_key",
        key: "secret-gemini-key-12345",
      },
      "github-copilot": {
        type: "oauth",
        access: "secret-copilot-token-abcde",
        refresh: "secret-copilot-refresh-67890",
        expires: Date.now() + 3600000,
      },
      anthropic: {
        type: "oauth",
        access: "secret-anthropic-access-token",
        refresh: "secret-anthropic-refresh-token",
        expires: Date.now() + 3600000,
      },
      openai: {
        type: "api_key",
        key: "secret-openai-key-99999",
      },
    };

    it("includes API keys and non-rotating OAuth by default, excludes rotating OAuth when not in opt-in", () => {
      const result = buildBundle({
        authEntries: mockAuthEntries,
        modelsJson: '{"models":[]}',
        settingsSubset: { defaultProvider: "anthropic" },
        agentsMd: "# Operating Manual",
        localConfig: {
          ...DEFAULT_LOCAL_CONFIG,
          providers: {
            synced: [],
            oauthOptIn: [], // anthropic is not opted in
            bedrockRole: false,
          },
        },
      });

      expect(result.secrets.has("google")).toBe(true);
      expect(result.secrets.has("github-copilot")).toBe(true);
      expect(result.secrets.has("openai")).toBe(true);
      expect(result.secrets.has("anthropic")).toBe(false); // Excluded by default

      expect(result.manifest.providers.sort()).toEqual(["github-copilot", "google", "openai"]);
    });

    it("includes rotating OAuth when explicitly listed in oauthOptIn", () => {
      const result = buildBundle({
        authEntries: mockAuthEntries,
        localConfig: {
          ...DEFAULT_LOCAL_CONFIG,
          providers: {
            synced: [],
            oauthOptIn: ["anthropic"],
            bedrockRole: false,
          },
        },
      });

      expect(result.secrets.has("anthropic")).toBe(true);
      expect(result.manifest.providers).toContain("anthropic");
    });

    it("honors explicit synced providers filter list", () => {
      const result = buildBundle({
        authEntries: mockAuthEntries,
        localConfig: {
          ...DEFAULT_LOCAL_CONFIG,
          providers: {
            synced: ["openai"],
            oauthOptIn: [],
            bedrockRole: false,
          },
        },
      });

      expect(result.secrets.size).toBe(1);
      expect(result.secrets.has("openai")).toBe(true);
      expect(result.secrets.has("google")).toBe(false);
    });

    it("strictly isolates secrets: ZERO secret tokens exist in bundleTar", () => {
      const result = buildBundle({
        authEntries: mockAuthEntries,
        modelsJson: '{"models":["gpt-4"]}',
        settingsSubset: { defaultProvider: "openai" },
        agentsMd: "# Project Guidelines",
        skills: {
          "code-review": "# Code review skill\n",
        },
        localConfig: {
          ...DEFAULT_LOCAL_CONFIG,
          providers: {
            synced: [],
            oauthOptIn: ["anthropic"],
            bedrockRole: false,
          },
        },
      });

      const tarBuffer = result.bundleTar;
      const tarString = tarBuffer.toString("utf8");

      // Verify no secret substrings appear in the TAR buffer
      expect(tarString).not.toContain("secret-gemini-key-12345");
      expect(tarString).not.toContain("secret-copilot-token-abcde");
      expect(tarString).not.toContain("secret-anthropic-access-token");
      expect(tarString).not.toContain("secret-openai-key-99999");
      expect(tarString).not.toContain("auth.json");

      // Verify non-secret files ARE in the TAR buffer
      expect(tarString).toContain("models.json");
      expect(tarString).toContain("settings.json");
      expect(tarString).toContain("AGENTS.md");
      expect(tarString).toContain("skills/code-review");
    });

    it("enforces 64 KB maximum secret size limit and warns on large secrets (> 16 KB)", () => {
      // Secret > 16 KB emits warning
      const largeAuth = {
        custom: {
          type: "api_key",
          key: "k".repeat(20000), // ~20 KB
        },
      };

      const result = buildBundle({
        authEntries: largeAuth,
      });

      expect(result.manifest.warnings).toBeDefined();
      expect(result.manifest.warnings?.[0]).toContain("is large");

      // Secret > 64 KB throws error
      const oversizedAuth = {
        oversized: {
          type: "api_key",
          key: "k".repeat(70000), // ~70 KB
        },
      };

      expect(() =>
        buildBundle({
          authEntries: oversizedAuth,
        }),
      ).toThrow(/exceeds AWS Secrets Manager 64 KB limit/);
    });
  });

  describe("assemblePiAgentDir (In-VM Assembly)", () => {
    it("assembles ~/.pi/agent with correct files, directory mode 0700, and auth.json mode 0600", () => {
      const authEntries = {
        google: { type: "api_key", key: "ai-key-12345" },
        openai: { type: "api_key", key: "sk-openai-67890" },
      };

      const bundle = buildBundle({
        authEntries,
        modelsJson: '{"customModels":[]}',
        settingsSubset: { defaultProvider: "google", defaultModel: "gemini-2.5-flash" },
        agentsMd: "# In-VM Operating Rules",
        skills: {
          "build-tool/SKILL.md": "# Build Tool",
        },
      });

      const targetAgentDir = path.join(tempDir, "agent");
      const assembled = assemblePiAgentDir(bundle.bundleTar, bundle.secrets, targetAgentDir);

      expect(assembled.length).toBeGreaterThanOrEqual(5);

      // Verify target directory permissions (0700) on POSIX
      if (process.platform !== "win32") {
        const dirMode = fs.statSync(targetAgentDir).mode & 0o777;
        expect(dirMode).toBe(0o700);
      }

      // Verify auth.json content and permissions (0600)
      const authPath = path.join(targetAgentDir, "auth.json");
      expect(fs.existsSync(authPath)).toBe(true);

      if (process.platform !== "win32") {
        const authMode = fs.statSync(authPath).mode & 0o777;
        expect(authMode).toBe(0o600);
      }

      const authParsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
      expect(authParsed.google.key).toBe("ai-key-12345");
      expect(authParsed.openai.key).toBe("sk-openai-67890");

      // Verify models.json
      const modelsPath = path.join(targetAgentDir, "models.json");
      expect(fs.existsSync(modelsPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(modelsPath, "utf8"))).toEqual({ customModels: [] });

      // Verify settings.json
      const settingsPath = path.join(targetAgentDir, "settings.json");
      expect(fs.existsSync(settingsPath)).toBe(true);
      const settingsParsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      expect(settingsParsed.defaultProvider).toBe("google");
      expect(settingsParsed.defaultModel).toBe("gemini-2.5-flash");

      // Verify AGENTS.md
      const agentsPath = path.join(targetAgentDir, "AGENTS.md");
      expect(fs.existsSync(agentsPath)).toBe(true);
      expect(fs.readFileSync(agentsPath, "utf8")).toBe("# In-VM Operating Rules\n");

      // Verify skill file
      const skillPath = path.join(targetAgentDir, "skills", "build-tool", "SKILL.md");
      expect(fs.existsSync(skillPath)).toBe(true);
      expect(fs.readFileSync(skillPath, "utf8")).toBe("# Build Tool\n");
    });
  });
});
