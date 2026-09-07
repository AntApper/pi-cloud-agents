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

    it("rejects TAR archive entries with directory traversal attempts", () => {
      const entries = [{ name: "../evil.txt", content: "malicious content\n" }];

      const tar = createDeterministicTar(entries);
      const destDir = path.join(tempDir, "extracted-safe");

      expect(() => extractTar(tar, destDir)).toThrow(/outside the target directory/);
      expect(fs.existsSync(path.join(tempDir, "evil.txt"))).toBe(false);
    });

    /**
     * Builds one raw 512-byte ustar header (+ padded data) so tests can craft entry types that
     * createDeterministicTar never emits (symlinks, GNU long names, PAX headers, ustar prefixes).
     */
    function rawTarEntry(
      name: string,
      content: string,
      opts: { typeFlag?: string; prefix?: string; linkName?: string } = {},
    ): Buffer {
      const data = Buffer.from(content, "utf8");
      const header = Buffer.alloc(512, 0);
      header.write(name, 0, 100, "utf8");
      header.write("000644 \0", 100, 8, "ascii");
      header.write("0000000\0", 108, 8, "ascii");
      header.write("0000000\0", 116, 8, "ascii");
      header.write(`${data.length.toString(8).padStart(11, "0")} `, 124, 12, "ascii");
      header.write("00000000000 ", 136, 12, "ascii");
      header.fill(0x20, 148, 156);
      header.write(opts.typeFlag ?? "0", 156, 1, "ascii");
      if (opts.linkName) header.write(opts.linkName, 157, 100, "utf8");
      header.write("ustar\0", 257, 6, "ascii");
      header.write("00", 263, 2, "ascii");
      if (opts.prefix) header.write(opts.prefix, 345, 155, "utf8");
      let checksum = 0;
      for (const byte of header) checksum += byte;
      header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
      const padding = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
      return Buffer.concat([header, data, padding]);
    }

    const endOfArchive = Buffer.alloc(1024, 0);

    it("honours the ustar prefix field for long paths", () => {
      const tar = Buffer.concat([
        rawTarEntry("SKILL.md", "# deep\n", { prefix: "skills/very/deep/tree" }),
        endOfArchive,
      ]);
      const destDir = path.join(tempDir, "prefix");

      const extracted = extractTar(tar, destDir);

      expect(extracted).toEqual([path.join(destDir, "skills/very/deep/tree/SKILL.md")]);
    });

    it("applies GNU long-name and PAX path headers to the following entry without writing them", () => {
      const longName = `${"nested/".repeat(20)}file.txt`;
      const paxRecord = "path=pax/renamed.txt\n";
      const paxData = `${paxRecord.length + 3} ${paxRecord}`;
      const tar = Buffer.concat([
        rawTarEntry("././@LongLink", `${longName}\0`, { typeFlag: "L" }),
        rawTarEntry("truncated-name.txt", "long content\n"),
        rawTarEntry("PaxHeader/x", paxData, { typeFlag: "x" }),
        rawTarEntry("short.txt", "pax content\n"),
        rawTarEntry("pax_global_header", "23 comment=ignored\n", { typeFlag: "g" }),
        endOfArchive,
      ]);
      const destDir = path.join(tempDir, "headers");

      const extracted = extractTar(tar, destDir);

      expect(extracted.sort()).toEqual(
        [path.join(destDir, longName), path.join(destDir, "pax/renamed.txt")].sort(),
      );
      expect(fs.readFileSync(path.join(destDir, longName), "utf8")).toBe("long content\n");
      expect(fs.readFileSync(path.join(destDir, "pax/renamed.txt"), "utf8")).toBe("pax content\n");
      for (const notWritten of ["././@LongLink", "truncated-name.txt", "PaxHeader", "short.txt"]) {
        expect(fs.existsSync(path.join(destDir, notWritten))).toBe(false);
      }
    });

    it("never materialises link, device or FIFO entries and refuses to write through an escaping PAX path", () => {
      const outside = path.join(tempDir, "outside");
      fs.mkdirSync(outside);
      const paxRecord = `path=${path.relative(path.join(tempDir, "links"), outside)}/escaped.txt\n`;
      const tar = Buffer.concat([
        rawTarEntry("link-to-outside", "", { typeFlag: "2", linkName: outside }),
        rawTarEntry("hardlink", "", { typeFlag: "1", linkName: "file.txt" }),
        rawTarEntry("fifo", "", { typeFlag: "6" }),
        rawTarEntry("file.txt", "ok\n"),
        endOfArchive,
      ]);
      const destDir = path.join(tempDir, "links");

      const extracted = extractTar(tar, destDir);
      expect(extracted).toEqual([path.join(destDir, "file.txt")]);
      expect(fs.readdirSync(destDir)).toEqual(["file.txt"]);

      const escaping = Buffer.concat([
        rawTarEntry("PaxHeader/x", `${paxRecord.length + 3} ${paxRecord}`, { typeFlag: "x" }),
        rawTarEntry("short.txt", "escaped\n"),
        endOfArchive,
      ]);
      expect(() => extractTar(escaping, destDir)).toThrow(/outside the target directory/);
      expect(fs.existsSync(path.join(outside, "escaped.txt"))).toBe(false);
    });

    it("refuses to write through a symlink that already exists inside the target directory", () => {
      const outside = path.join(tempDir, "outside-target");
      fs.mkdirSync(outside);
      const destDir = path.join(tempDir, "symlinked");
      fs.mkdirSync(destDir);
      fs.symlinkSync(outside, path.join(destDir, "skills"), "dir");

      const tar = createDeterministicTar([{ name: "skills/evil.md", content: "escape\n" }]);

      expect(() => extractTar(tar, destDir)).toThrow(/real path escapes the target directory/);
      expect(fs.existsSync(path.join(outside, "evil.md"))).toBe(false);

      // A symlink standing in for the file itself is rejected as well.
      fs.symlinkSync(path.join(outside, "target.json"), path.join(destDir, "models.json"));
      const fileTar = createDeterministicTar([{ name: "models.json", content: "{}\n" }]);
      expect(() => extractTar(fileTar, destDir)).toThrow(/existing symbolic link/);
      expect(fs.existsSync(path.join(outside, "target.json"))).toBe(false);
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
