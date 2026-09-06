/**
 * Unit tests for In-VM Secret Redaction Extension and Transcript Sanitizer (T5.1).
 */

import { describe, expect, it, vi } from "vitest";
import redactExtension, {
  parseRedactionEnv,
  redactObject,
  redactText,
} from "../../runner/pi-extensions/redact.js";

describe("T5.1 In-VM Secret Redaction Extension", () => {
  describe("parseRedactionEnv", () => {
    it("parses JSON object mapping secret names to values", () => {
      const jsonMap = JSON.stringify({
        GITHUB_TOKEN: "ghp_secretToken123456",
        ANTHROPIC_API_KEY: "sk-ant-api03-abcdefg987654321",
      });

      const rules = parseRedactionEnv(jsonMap, {});
      expect(rules.length).toBeGreaterThanOrEqual(2);
      expect(rules).toContainEqual({
        name: "GITHUB_TOKEN",
        value: "ghp_secretToken123456",
      });
      expect(rules).toContainEqual({
        name: "ANTHROPIC_API_KEY",
        value: "sk-ant-api03-abcdefg987654321",
      });
    });

    it("parses JSON array of environment variable keys and reads from processEnv", () => {
      const jsonArray = JSON.stringify(["CUSTOM_API_KEY", "DATABASE_PASSWORD"]);
      const mockEnv = {
        CUSTOM_API_KEY: "super-secret-key-123",
        DATABASE_PASSWORD: "very-secure-password-456",
      };

      const rules = parseRedactionEnv(jsonArray, mockEnv);
      expect(rules).toContainEqual({
        name: "CUSTOM_API_KEY",
        value: "super-secret-key-123",
      });
      expect(rules).toContainEqual({
        name: "DATABASE_PASSWORD",
        value: "very-secure-password-456",
      });
    });

    it("parses comma-separated list of environment variable keys", () => {
      const commaSeparated = "GH_TOKEN, OPENAI_API_KEY";
      const mockEnv = {
        GH_TOKEN: "ghp_anotherSecretToken789",
        OPENAI_API_KEY: "sk-proj-openaiSecretKey123",
      };

      const rules = parseRedactionEnv(commaSeparated, mockEnv);
      expect(rules).toContainEqual({
        name: "GH_TOKEN",
        value: "ghp_anotherSecretToken789",
      });
      expect(rules).toContainEqual({
        name: "OPENAI_API_KEY",
        value: "sk-proj-openaiSecretKey123",
      });
    });

    it("automatically detects common sensitive keys from processEnv", () => {
      const mockEnv = {
        GITHUB_TOKEN: "ghp_defaultDetectedToken",
        ANTHROPIC_API_KEY: "sk-ant-detectedKey",
        APP_SECRET_TOKEN: "app-secret-value-abc",
        REGULAR_VAR: "regular-public-value",
      };

      const rules = parseRedactionEnv(undefined, mockEnv);
      expect(rules.some((r) => r.name === "GITHUB_TOKEN")).toBe(true);
      expect(rules.some((r) => r.name === "ANTHROPIC_API_KEY")).toBe(true);
      expect(rules.some((r) => r.name === "APP_SECRET_TOKEN")).toBe(true);
      expect(rules.some((r) => r.name === "REGULAR_VAR")).toBe(false);
    });

    it("ignores values with less than 4 characters to prevent over-redaction", () => {
      const mockEnv = {
        GITHUB_TOKEN: "abc",
      };
      const rules = parseRedactionEnv(undefined, mockEnv);
      expect(rules.some((r) => r.value === "abc")).toBe(false);
    });

    it("sorts rules descending by length so longer substrings are matched first", () => {
      const mockEnv = {
        SHORT_KEY: "secret",
        LONG_KEY: "secret_extended_longer_key",
      };
      const rules = parseRedactionEnv("SHORT_KEY, LONG_KEY", mockEnv);
      expect(rules[0]!.value).toBe("secret_extended_longer_key");
      expect(rules[1]!.value).toBe("secret");
    });
  });

  describe("redactText", () => {
    it("replaces secret tokens with [REDACTED:<NAME>]", () => {
      const rules = [
        { name: "GITHUB_TOKEN", value: "ghp_mySuperSecretGitToken" },
        { name: "OPENAI_API_KEY", value: "sk-openaiKey98765" },
      ];

      const input =
        "Clone repo using https://x-access-token:ghp_mySuperSecretGitToken@github.com/org/repo with key sk-openaiKey98765.";
      const result = redactText(input, rules);

      expect(result).toBe(
        "Clone repo using https://x-access-token:[REDACTED:GITHUB_TOKEN]@github.com/org/repo with key [REDACTED:OPENAI_API_KEY].",
      );
      expect(result).not.toContain("ghp_mySuperSecretGitToken");
      expect(result).not.toContain("sk-openaiKey98765");
    });

    it("masks 12-digit AWS account numbers", () => {
      const input = "Resource ARN is arn:aws:lambda:us-east-1:123456789012:function:my-function";
      const result = redactText(input, []);
      expect(result).toBe(
        "Resource ARN is arn:aws:lambda:us-east-1:<ACCOUNT_ID>:function:my-function",
      );
      expect(result).not.toContain("123456789012");
    });

    it("handles null or non-string inputs safely", () => {
      expect(redactText(null as unknown as string)).toBe(null);
      expect(redactText(undefined as unknown as string)).toBe(undefined);
    });
  });

  describe("redactObject", () => {
    it("deeply redacts nested objects, arrays, and errors", () => {
      const rules = [{ name: "API_KEY", value: "secret-api-key-xyz" }];

      const obj = {
        title: "Test Report",
        nested: {
          key: "secret-api-key-xyz in nested object",
          tags: ["public", "secret-api-key-xyz in array"],
        },
        error: new Error("Failed connecting with secret-api-key-xyz"),
        count: 42,
        active: true,
      };

      const redacted = redactObject(obj, rules);

      expect(redacted.nested.key).toBe("[REDACTED:API_KEY] in nested object");
      expect(redacted.nested.tags[1]).toBe("[REDACTED:API_KEY] in array");
      expect(redacted.error.message).toBe("Failed connecting with [REDACTED:API_KEY]");
      expect(redacted.count).toBe(42);
      expect(redacted.active).toBe(true);
    });

    it("handles circular references without infinite recursion", () => {
      const rules = [{ name: "TOKEN", value: "my-secret-token" }];
      const circularObj: Record<string, unknown> = {
        field: "Contains my-secret-token",
      };
      circularObj.self = circularObj;

      const result = redactObject(circularObj, rules);
      expect(result.field).toBe("Contains [REDACTED:TOKEN]");
      expect(result.self).toBeDefined();
    });
  });

  describe("pi Extension lifecycle hook integration", () => {
    it("registers tool_result and message_end handlers and intercepts output", async () => {
      const originalEnv = process.env.PI_CLOUD_REDACT_ENV;
      const testSecret = "ghp_inVmTestSecretValue999";
      process.env.PI_CLOUD_REDACT_ENV = JSON.stringify({
        GITHUB_TOKEN: testSecret,
      });

      const registeredHandlers: Record<
        string,
        (event: Record<string, unknown>) => Promise<{ content?: unknown[]; details?: unknown; message?: { content?: Array<{ type: string; text: string }> } } | undefined>
      > = {};
      const fakePi: unknown = {
        on: vi.fn((event: string, handler: (event: Record<string, unknown>) => Promise<any>) => {
          registeredHandlers[event] = handler;
        }),
      };

      try {
        redactExtension(fakePi as any);

        expect((fakePi as any).on).toHaveBeenCalledWith("tool_result", expect.any(Function));
        expect((fakePi as any).on).toHaveBeenCalledWith("message_end", expect.any(Function));

        // Test tool_result redaction
        const toolResultHandler = registeredHandlers.tool_result;
        expect(toolResultHandler).toBeDefined();
        const toolResultEvent = {
          toolName: "bash",
          toolCallId: "call_123",
          content: [
            {
              type: "text",
              text: `echo $GITHUB_TOKEN output: ${testSecret}`,
            },
          ],
          details: {
            stdout: `Raw output: ${testSecret}`,
          },
        };

        const resultPatch = toolResultHandler
          ? await toolResultHandler(toolResultEvent)
          : undefined;
        expect(resultPatch).toBeDefined();
        expect(((resultPatch as any)?.content as any[])[0].text).toBe(
          "echo $GITHUB_TOKEN output: [REDACTED:GITHUB_TOKEN]",
        );
        expect(((resultPatch as any)?.details as any).stdout).toBe("Raw output: [REDACTED:GITHUB_TOKEN]");

        // Test message_end redaction
        const messageEndHandler = registeredHandlers.message_end;
        expect(messageEndHandler).toBeDefined();
        const messageEndEvent = {
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `I executed the command with secret ${testSecret}`,
              },
            ],
          },
        };

        const messagePatch = messageEndHandler
          ? await messageEndHandler(messageEndEvent)
          : undefined;
        expect(messagePatch).toBeDefined();
        expect((messagePatch as any)?.message?.content?.[0]?.text).toBe(
          "I executed the command with secret [REDACTED:GITHUB_TOKEN]",
        );
      } finally {
        process.env.PI_CLOUD_REDACT_ENV = originalEnv;
      }
    });
  });
});
