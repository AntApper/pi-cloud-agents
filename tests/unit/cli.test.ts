import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI_VERSION, discoverCredentialsWithoutPi, parseCliArgs, runCli } from "../../cli/main.js";

describe("Standalone CLI Tool (T4.3c)", () => {
  let tmpDir: string;
  let stdoutLogs: string[];
  let stderrLogs: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cli-test-"));
    stdoutLogs = [];
    stderrLogs = [];

    originalLog = console.log;
    originalError = console.error;

    console.log = (...args: unknown[]) => {
      stdoutLogs.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      stderrLogs.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe("parseCliArgs", () => {
    it("parses commands, sub-arguments, and long/short flags accurately", () => {
      const parsed = parseCliArgs([
        "node",
        "cli/main.js",
        "setup",
        "--dry-run",
        "--profile",
        "work-profile",
        "-r",
        "us-west-2",
        "--non-interactive",
        "extra-arg",
      ]);

      expect(parsed.command).toBe("setup");
      expect(parsed.flags["dry-run"]).toBe(true);
      expect(parsed.flags.profile).toBe("work-profile");
      expect(parsed.flags.r).toBe("us-west-2");
      expect(parsed.flags["non-interactive"]).toBe(true);
      expect(parsed.subArgs).toEqual(["extra-arg"]);
    });

    it("handles help and version flags", () => {
      expect(parseCliArgs(["node", "cli/main.js", "--help"]).command).toBe("help");
      expect(parseCliArgs(["node", "cli/main.js", "-h"]).command).toBe("help");
      expect(parseCliArgs(["node", "cli/main.js", "--version"]).command).toBe("version");
      expect(parseCliArgs(["node", "cli/main.js", "-v"]).command).toBe("version");
    });
  });

  describe("discoverCredentialsWithoutPi", () => {
    it("reads credentials from auth.json and supplements from environment variables", () => {
      const authPath = path.join(tmpDir, "auth.json");
      fs.writeFileSync(
        authPath,
        JSON.stringify({
          anthropic: { type: "api_key", key: "sk-ant-from-file" },
        }),
      );

      process.env.OPENAI_API_KEY = "sk-openai-from-env";
      process.env.ANTHROPIC_API_KEY = "sk-ant-from-env"; // Should not overwrite file

      const creds = discoverCredentialsWithoutPi(tmpDir);

      expect(creds.anthropic).toEqual({ type: "api_key", key: "sk-ant-from-file" });
      expect(creds.openai).toEqual({ type: "api_key", key: "sk-openai-from-env" });

      process.env.OPENAI_API_KEY = undefined;
      process.env.ANTHROPIC_API_KEY = undefined;
    });
  });

  describe("runCli commands", () => {
    it("executes 'version' command with text and JSON output", async () => {
      const exit0 = await runCli(["node", "main.js", "version"]);
      expect(exit0).toBe(0);
      expect(stdoutLogs.join("\n")).toContain(`pi-cloud-agents v${CLI_VERSION}`);

      stdoutLogs = [];
      const exitJson = await runCli(["node", "main.js", "version", "--json"]);
      expect(exitJson).toBe(0);
      const parsed = JSON.parse(stdoutLogs.join("\n"));
      expect(parsed.version).toBe(CLI_VERSION);
    });

    it("executes 'help' command", async () => {
      const exitCode = await runCli(["node", "main.js", "help"]);
      expect(exitCode).toBe(0);
      expect(stdoutLogs.join("\n")).toContain("Autonomous cloud coding agents");
      expect(stdoutLogs.join("\n")).toContain("setup");
      expect(stdoutLogs.join("\n")).toContain("verify");
    });

    it("executes 'setup --dry-run --non-interactive --config tests/fixtures/setup.json'", async () => {
      const fixturePath = path.resolve(process.cwd(), "tests", "fixtures", "setup.json");
      const exitCode = await runCli([
        "node",
        "main.js",
        "setup",
        "--dry-run",
        "--non-interactive",
        "--config",
        fixturePath,
      ]);

      expect(exitCode).toBe(0);
      const output = stdoutLogs.join("\n");
      expect(output).toContain("pi cloud agents · Setup Plan");
      expect(output).toContain("Plan preview generated (dry-run)");
    });

    it("returns exit code 1 for missing configuration file", async () => {
      const exitCode = await runCli([
        "node",
        "main.js",
        "setup",
        "--config",
        "/tmp/non-existent-config-file.json",
      ]);

      expect(exitCode).toBe(1);
      expect(stderrLogs.join("\n")).toContain("Configuration file not found");
    });

    it("returns exit code 1 for unknown command", async () => {
      const exitCode = await runCli(["node", "main.js", "unknown-cmd"]);
      expect(exitCode).toBe(1);
      expect(stderrLogs.join("\n")).toContain("Unknown command: 'unknown-cmd'");
    });
  });
});
