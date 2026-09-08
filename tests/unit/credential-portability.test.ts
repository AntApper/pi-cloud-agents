import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ApiKeyCredential,
  type OAuthCredential,
  SECRETS_MANAGER_MAX_BYTES,
  analyzeAuthContent,
  analyzeProviderCredential,
  calculateCredentialSize,
  formatCredentialPortabilityTable,
  maskCredentialEntry,
  maskSecretValue,
  parseAuthJson,
  resolveKeyType,
  runCredentialSpike,
  simulateSandboxExport,
  validateCredentialEntry,
} from "../../core/credentials.js";
import { findForbiddenGlyphs } from "../../scripts/doc-glyph-scan.js";

describe("Credential Portability & Auth Store Analysis (T0.6)", () => {
  describe("resolveKeyType", () => {
    it("identifies literal keys", () => {
      expect(resolveKeyType("test-literal-key-123456")).toBe("literal");
      expect(resolveKeyType("plain-api-key")).toBe("literal");
      expect(resolveKeyType("$$literal-dollar")).toBe("literal");
      expect(resolveKeyType("$!literal-bang")).toBe("literal");
    });

    it("identifies command execution keys", () => {
      expect(resolveKeyType("!security find-generic-password -s anthropic")).toBe("command");
      expect(resolveKeyType("!op read op://vault/item/secret")).toBe("command");
    });

    it("identifies environment variable interpolation keys", () => {
      expect(resolveKeyType("$ANTHROPIC_API_KEY")).toBe("env_var");
      expect(resolveKeyType("${MY_CUSTOM_KEY}")).toBe("env_var");
    });

    it("identifies empty keys", () => {
      expect(resolveKeyType("")).toBe("empty");
      expect(resolveKeyType("   ")).toBe("empty");
      expect(resolveKeyType(undefined)).toBe("empty");
    });
  });

  describe("maskSecretValue & maskCredentialEntry", () => {
    it("masks secrets safely without leaking raw values", () => {
      const raw = "mock-secret-payload-longer-than-sixteen-chars-abcdef1234567890";
      const masked = maskSecretValue(raw);

      expect(masked).not.toContain("payload-longer-than-sixteen");
      expect(masked).toContain("mock-s***7890");
      expect(masked).toContain("chars)");
    });

    it("masks short secrets completely", () => {
      expect(maskSecretValue("secret1")).toBe("********");
      expect(maskSecretValue("")).toBe("<empty>");
      expect(maskSecretValue(undefined)).toBe("<empty>");
    });

    it("masks ApiKeyCredential entries including env mappings", () => {
      const entry: ApiKeyCredential = {
        type: "api_key",
        key: "sk-test-secret-key-123456789",
        env: {
          CLOUDFLARE_ACCOUNT_ID: "account-12345678",
          CLOUDFLARE_API_KEY: "cf-key-secret-987654321",
        },
      };

      const masked = maskCredentialEntry(entry);
      expect(masked.type).toBe("api_key");
      expect(masked.key).not.toContain("123456789");
      const maskedEnv = masked.env as Record<string, string>;
      expect(maskedEnv.CLOUDFLARE_API_KEY).not.toContain("987654321");
    });

    it("masks OAuthCredential entries", () => {
      const entry: OAuthCredential = {
        type: "oauth",
        access: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.verylongaccesssecretpayload",
        refresh: "rt_secret_refresh_token_value_here_12345",
        expires: 1757174400000,
        accountId: "chatgpt-acc-123",
      };

      const masked = maskCredentialEntry(entry);
      expect(masked.type).toBe("oauth");
      expect(masked.access).not.toContain("verylongaccesssecretpayload");
      expect(masked.refresh).not.toContain("12345");
      expect(masked.accountId).toBe("chatgpt-acc-123");
    });
  });

  describe("validateCredentialEntry & parseAuthJson", () => {
    it("validates valid API key and OAuth entries", () => {
      const rawApi = { type: "api_key", key: "sk-abc" };
      const resApi = validateCredentialEntry("anthropic", rawApi);
      expect(resApi.valid).toBe(true);
      expect(resApi.credential?.type).toBe("api_key");

      const rawOAuth = {
        type: "oauth",
        access: "acc",
        refresh: "ref",
        expires: 123456,
      };
      const resOAuth = validateCredentialEntry("openai-codex", rawOAuth);
      expect(resOAuth.valid).toBe(true);
      expect(resOAuth.credential?.type).toBe("oauth");
    });

    it("rejects invalid credential entries", () => {
      expect(validateCredentialEntry("test", null).valid).toBe(false);
      expect(validateCredentialEntry("test", []).valid).toBe(false);
      expect(validateCredentialEntry("test", { type: "unknown_type" }).valid).toBe(false);
      expect(validateCredentialEntry("test", { type: "oauth", access: "a" }).valid).toBe(false); // missing refresh
    });

    it("parses valid auth.json string correctly", () => {
      const json = JSON.stringify({
        anthropic: { type: "api_key", key: "sk-ant-test" },
        "github-copilot": {
          type: "oauth",
          access: "gh_acc",
          refresh: "gh_ref",
          expires: 1800000000000,
        },
      });

      const parsed = parseAuthJson(json);
      expect(parsed.rawCount).toBe(2);
      expect(parsed.errors).toHaveLength(0);
      expect(parsed.credentials.anthropic?.type).toBe("api_key");
      expect(parsed.credentials["github-copilot"]?.type).toBe("oauth");
    });

    it("handles corrupt JSON gracefully", () => {
      const parsed = parseAuthJson("invalid-json{");
      expect(parsed.rawCount).toBe(0);
      expect(parsed.errors.length).toBeGreaterThan(0);
      expect(parsed.errors[0]).toContain("Invalid JSON format");
    });
  });

  describe("calculateCredentialSize & Secrets Manager limit", () => {
    it("measures byte length of credential entries", () => {
      const entry: ApiKeyCredential = { type: "api_key", key: "sk-12345" };
      const size = calculateCredentialSize(entry);
      expect(size).toBe(Buffer.byteLength(JSON.stringify(entry), "utf8"));
      expect(size).toBeLessThan(100);
    });

    it("validates entries fit well within the 64 KB limit (Assumption A10)", () => {
      const typicalOAuth: OAuthCredential = {
        type: "oauth",
        access: "a".repeat(1500),
        refresh: "r".repeat(200),
        expires: Date.now() + 3600000,
        availableModelIds: Array.from({ length: 30 }, (_, i) => `model-id-${i}`),
      };

      const size = calculateCredentialSize(typicalOAuth);
      expect(size).toBeLessThan(3000);
      expect(size).toBeLessThan(SECRETS_MANAGER_MAX_BYTES);
    });

    it("detects oversized payloads exceeding 64 KB", () => {
      const giantEntry = {
        type: "api_key",
        key: "x".repeat(SECRETS_MANAGER_MAX_BYTES + 100),
      };
      expect(calculateCredentialSize(giantEntry)).toBeGreaterThan(SECRETS_MANAGER_MAX_BYTES);
    });
  });

  describe("analyzeProviderCredential & analyzeAuthContent", () => {
    it("analyzes API key providers as portable with no refresh conflict", () => {
      const cred: ApiKeyCredential = { type: "api_key", key: "sk-ant-test" };
      const analysis = analyzeProviderCredential("anthropic", cred);

      expect(analysis.portability).toBe("portable");
      expect(analysis.refreshConflictRisk).toBe("not_applicable");
      expect(analysis.syncRecommendation).toBe("default_sync");
      expect(analysis.fitsInSecretsManager).toBe(true);
    });

    it("analyzes rotating OAuth providers as conditional with conflict risk", () => {
      const cred: OAuthCredential = {
        type: "oauth",
        access: "acc",
        refresh: "ref",
        expires: 1000,
      };
      const analysis = analyzeProviderCredential("anthropic", cred);

      expect(analysis.portability).toBe("conditional");
      expect(analysis.refreshConflictRisk).toBe("conflict");
      expect(analysis.syncRecommendation).toBe("opt_in_notice");
    });

    it("analyzes GitHub Copilot and OpenRouter OAuth as non-conflicting", () => {
      const copilotCred: OAuthCredential = {
        type: "oauth",
        access: "gh_acc",
        refresh: "gh_ref",
        expires: 1000,
      };
      const copilotAnalysis = analyzeProviderCredential("github-copilot", copilotCred);
      expect(copilotAnalysis.portability).toBe("portable");
      expect(copilotAnalysis.refreshConflictRisk).toBe("none");

      const openRouterOAuthCred: OAuthCredential = {
        type: "oauth",
        access: "sk-or-v1-test",
        refresh: "",
        expires: Number.MAX_SAFE_INTEGER,
      };
      const openRouterAnalysis = analyzeProviderCredential("openrouter", openRouterOAuthCred);
      expect(openRouterAnalysis.portability).toBe("portable");
      expect(openRouterAnalysis.refreshConflictRisk).toBe("none");
    });

    it("analyzes Bedrock ambient credentials", () => {
      const bedrockAnalysis = analyzeProviderCredential("amazon-bedrock");
      expect(bedrockAnalysis.type).toBe("ambient");
      expect(bedrockAnalysis.portability).toBe("ambient_only");
      expect(bedrockAnalysis.syncRecommendation).toBe("ambient_role");
    });

    it("produces comprehensive report from auth.json content", () => {
      const json = JSON.stringify({
        anthropic: { type: "api_key", key: "sk-ant-test" },
        "openai-codex": {
          type: "oauth",
          access: "acc",
          refresh: "ref",
          expires: 12345,
        },
      });

      const report = analyzeAuthContent(json, "/tmp/mock/auth.json");
      expect(report.totalProviders).toBe(2);
      expect(report.validProviders).toBe(2);
      expect(report.allFitSecretsManager).toBe(true);
      expect(report.providers).toHaveLength(2);
    });
  });

  describe("simulateSandboxExport", () => {
    it("simulates syncing credentials to a target sandbox directory", () => {
      const tempDir = path.join(os.tmpdir(), `test-sandbox-${Date.now()}`);
      const creds: Record<string, ApiKeyCredential | OAuthCredential> = {
        anthropic: { type: "api_key", key: "sk-ant-123" },
        "github-copilot": {
          type: "oauth",
          access: "acc",
          refresh: "ref",
          expires: 1000,
        },
        "openai-codex": {
          type: "oauth",
          access: "acc2",
          refresh: "ref2",
          expires: 2000,
        },
      };

      try {
        // Without opt-in, rotating OAuth (openai-codex) is skipped, API key + Copilot exported
        const res = simulateSandboxExport(creds, tempDir);
        expect(res.success).toBe(true);
        expect(res.exportedProviders).toContain("anthropic");
        expect(res.exportedProviders).toContain("github-copilot");
        expect(res.exportedProviders).not.toContain("openai-codex");
        expect(res.skippedProviders).toHaveLength(1);
        expect(res.skippedProviders[0]?.providerId).toBe("openai-codex");

        // Verify file written to disk
        expect(fs.existsSync(res.authJsonPath)).toBe(true);
        const written = JSON.parse(fs.readFileSync(res.authJsonPath, "utf8"));
        expect(written.anthropic.key).toBe("sk-ant-123");
        expect(written["github-copilot"].access).toBe("acc");
        expect(written["openai-codex"]).toBeUndefined();

        // With explicit opt-in, rotating OAuth is exported
        const tempDir2 = path.join(os.tmpdir(), `test-sandbox-optin-${Date.now()}`);
        const resOptIn = simulateSandboxExport(creds, tempDir2, {
          optInOAuthProviders: ["openai-codex"],
        });
        expect(resOptIn.exportedProviders).toContain("openai-codex");
        const writtenOptIn = JSON.parse(fs.readFileSync(resOptIn.authJsonPath, "utf8"));
        expect(writtenOptIn["openai-codex"]).toBeDefined();
        fs.rmSync(tempDir2, { recursive: true, force: true });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("runCredentialSpike & formatCredentialPortabilityTable", () => {
    it("executes the spike and produces a clean formatted table", () => {
      const report = runCredentialSpike();
      expect(report.assumptionA10Status).toBe("VERIFIED");
      expect(report.knownProvidersMatrix.length).toBeGreaterThanOrEqual(15);

      const table = formatCredentialPortabilityTable(report);
      expect(table).toContain("pi Credential Portability Spike (T0.6)");
      expect(table).toContain("Assumption A10");
      expect(table).toContain("VERIFIED");
      expect(table).toContain("ADR-5");
      expect(table).toContain("OAuth Token Broker");

      // Verify no forbidden emojis or glyphs in table output
      const violations = findForbiddenGlyphs(table);
      expect(violations).toHaveLength(0);
    });
  });
});
