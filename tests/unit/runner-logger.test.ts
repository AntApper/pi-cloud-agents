/**
 * Unit tests for T2.2 Structured Logger with Deep Secret Redaction.
 * Tests JSON formatting, log levels, secret registration, and recursive redaction
 * across strings, arguments, nested objects, arrays, Error stacks, and circular refs.
 */

import { describe, expect, it } from "vitest";
import { type LogEntry, createLogger } from "../../runner/logger.js";

describe("T2.2 Structured Logger & Redaction Engine", () => {
  it("formats log entries as structured JSON with level and timestamp", () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({
      level: "debug",
      sink: (entry) => entries.push(entry),
    });

    logger.info("Runner initialized", { port: 8080 });

    expect(entries.length).toBe(1);
    const entry = entries[0]!;
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("Runner initialized");
    expect(entry.port).toBe(8080);
    expect(entry.time).toBeDefined();
    expect(new Date(entry.time).getTime()).toBeGreaterThan(0);
  });

  it("filters messages below the configured log level", () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({
      level: "warn",
      sink: (entry) => entries.push(entry),
    });

    logger.debug("Debug message");
    logger.info("Info message");
    logger.warn("Warning message");
    logger.error("Error message");

    expect(entries.length).toBe(2);
    expect(entries[0]!.level).toBe("warn");
    expect(entries[1]!.level).toBe("error");
  });

  it("redacts registered secret from plain string messages and args", () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({
      level: "info",
      sink: (entry) => entries.push(entry),
    });

    const secretKey = "sk-ant-api03-abcdef123456789";
    logger.registerSecret(secretKey);

    logger.info(`Fetching model with key: ${secretKey}`);
    logger.info("Executing command", { cmd: `curl -H "Authorization: Bearer ${secretKey}"` });

    expect(entries.length).toBe(2);
    expect(entries[0]!.msg).toBe("Fetching model with key: [REDACTED]");
    expect(entries[0]!.msg).not.toContain(secretKey);

    expect(entries[1]!.cmd).toBe('curl -H "Authorization: Bearer [REDACTED]"');
    expect(entries[1]!.cmd).not.toContain(secretKey);
  });

  it("redacts registered secrets in deeply nested objects and arrays", () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({
      level: "info",
      sink: (entry) => entries.push(entry),
    });

    const secretToken = "ghp_secure_github_pat_998877665544";
    logger.registerSecret(secretToken);

    const complexPayload = {
      user: {
        profile: {
          token: secretToken,
          previousTokens: ["old_token_1", secretToken],
        },
      },
      headers: [`Authorization: token ${secretToken}`],
    };

    logger.info(complexPayload);

    expect(entries.length).toBe(1);
    const entry = entries[0]!;
    const user = entry.user as { profile: { token: string; previousTokens: string[] } };
    expect(user.profile.token).toBe("[REDACTED]");
    expect(user.profile.previousTokens[1]).toBe("[REDACTED]");

    const headers = entry.headers as string[];
    expect(headers[0]).toBe("Authorization: token [REDACTED]");

    const rawJson = JSON.stringify(entry);
    expect(rawJson).not.toContain(secretToken);
  });

  it("redacts registered secrets from Error objects and error stacks", () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({
      level: "error",
      sink: (entry) => entries.push(entry),
    });

    const secretPassword = "super_secret_password_xyz123";
    logger.registerSecret(secretPassword);

    const err = new Error(`Connection failed with auth: ${secretPassword}`);
    logger.error("Operation failed", { error: err });

    expect(entries.length).toBe(1);
    const rawJson = JSON.stringify(entries[0]!);
    expect(rawJson).not.toContain(secretPassword);
    expect(rawJson).toContain("[REDACTED]");
  });

  it("handles overlapping secrets by redacting longer strings first", () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({
      level: "info",
      sink: (entry) => entries.push(entry),
    });

    logger.registerSecret("token_123");
    logger.registerSecret("token_123_extended_suffix");

    logger.info("Using token_123_extended_suffix for request");

    expect(entries[0]!.msg).toBe("Using [REDACTED] for request");
    expect(entries[0]!.msg).not.toContain("token_123");
  });

  it("extracts secrets recursively from JSON objects passed to registerSecret", () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({
      level: "info",
      sink: (entry) => entries.push(entry),
    });

    const authObject = {
      type: "oauth",
      key: "secret_api_key_112233",
      refresh: "secret_refresh_token_445566",
      nested: {
        access: "secret_access_token_778899",
      },
    };

    logger.registerSecret(JSON.stringify(authObject));

    logger.info("Keys:", {
      k: "secret_api_key_112233",
      r: "secret_refresh_token_445566",
      a: "secret_access_token_778899",
    });

    const rawJson = JSON.stringify(entries[0]!);
    expect(rawJson).not.toContain("secret_api_key_112233");
    expect(rawJson).not.toContain("secret_refresh_token_445566");
    expect(rawJson).not.toContain("secret_access_token_778899");
    expect(rawJson).toContain("[REDACTED]");
  });

  it("handles circular object references without crashing", () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({
      level: "info",
      sink: (entry) => entries.push(entry),
    });

    const circularObj: Record<string, unknown> = {
      name: "node",
      secret: "my_secret_code_1234",
    };
    circularObj.self = circularObj;

    logger.registerSecret("my_secret_code_1234");
    logger.info(circularObj);

    expect(entries.length).toBe(1);
    expect(entries[0]!.secret).toBe("[REDACTED]");
    const selfRef = entries[0]!.self as Record<string, unknown>;
    expect(selfRef.self).toBe("[Circular]");
  });

  it("supports child loggers inheriting secrets and context", () => {
    const entries: LogEntry[] = [];
    const rootLogger = createLogger({
      level: "info",
      sink: (entry) => entries.push(entry),
      defaultContext: { service: "runner" },
    });

    rootLogger.registerSecret("root_secret_token_1234");

    const child = rootLogger.child({ runId: "run-001" });
    child.info("Child log with root_secret_token_1234");

    expect(entries.length).toBe(1);
    expect(entries[0]!.service).toBe("runner");
    expect(entries[0]!.runId).toBe("run-001");
    expect(entries[0]!.msg).toBe("Child log with [REDACTED]");
  });
});
