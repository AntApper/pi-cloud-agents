/**
 * In-VM Secret Redaction Extension and Transcript Sanitizer (T5.1).
 * Intercepts pi RPC lifecycle events (tool_result, message_end, etc.) inside the MicroVM
 * and redacts registered secrets, tokens, API keys, and AWS account IDs.
 *
 * Replaces occurrences with `[REDACTED:<NAME>]`.
 * Redaction rules are loaded from environment variables (e.g. PI_CLOUD_REDACT_ENV)
 * and common sensitive credential environment variables.
 */

import type {
  AgentMessage,
  ExtensionAPI,
  ImageContent,
  MessageEndEvent,
  MessageEndEventResult,
  TextContent,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { maskAccountId } from "../../core/aws/mask.js";

export interface RedactionRule {
  name: string;
  value: string;
}

/** Known sensitive environment variable names to inspect by default. */
export const DEFAULT_SENSITIVE_ENV_KEYS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "COHERE_API_KEY",
  "PERPLEXITY_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "PI_CLOUD_SECRET",
];

/**
 * Parses redaction rules from environment variables or custom mappings.
 * Supports:
 *  1. JSON object string: `{"GITHUB_TOKEN": "ghp_xxx", "ANTHROPIC_API_KEY": "sk-ant-xxx"}`
 *  2. JSON array string of env var names: `["GITHUB_TOKEN", "ANTHROPIC_API_KEY"]`
 *  3. Comma-separated env var names: `"GITHUB_TOKEN,ANTHROPIC_API_KEY"`
 *  4. Fallback inspection of known sensitive keys in processEnv.
 */
export function parseRedactionEnv(
  redactEnv?: string,
  processEnv: Record<string, string | undefined> = process.env,
): RedactionRule[] {
  const rulesMap = new Map<string, string>();

  // 1. Process explicit redactEnv if provided
  if (redactEnv && redactEnv.trim().length > 0) {
    const trimmed = redactEnv.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        for (const [key, val] of Object.entries(parsed)) {
          if (typeof val === "string" && val.trim().length >= 4) {
            rulesMap.set(val.trim(), key.toUpperCase());
          }
        }
      } catch {
        // Fall through
      }
    } else if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed) as string[];
        for (const envKey of parsed) {
          if (typeof envKey === "string") {
            const val = processEnv[envKey];
            if (val && typeof val === "string" && val.trim().length >= 4) {
              rulesMap.set(val.trim(), envKey.toUpperCase());
            }
          }
        }
      } catch {
        // Fall through
      }
    } else {
      const parts = trimmed.split(/[\s,]+/);
      for (const envKey of parts) {
        if (envKey) {
          const val = processEnv[envKey];
          if (val && typeof val === "string" && val.trim().length >= 4) {
            rulesMap.set(val.trim(), envKey.toUpperCase());
          }
        }
      }
    }
  }

  // 2. Scan standard sensitive environment variables
  for (const envKey of DEFAULT_SENSITIVE_ENV_KEYS) {
    const val = processEnv[envKey];
    if (val && typeof val === "string" && val.trim().length >= 4) {
      if (!rulesMap.has(val.trim())) {
        rulesMap.set(val.trim(), envKey.toUpperCase());
      }
    }
  }

  // Also check any env var containing TOKEN, KEY, SECRET, or PASSWORD
  for (const [k, val] of Object.entries(processEnv)) {
    if (!val || typeof val !== "string" || val.trim().length < 4) continue;
    const upperKey = k.toUpperCase();
    if (
      (upperKey.includes("TOKEN") ||
        upperKey.includes("SECRET") ||
        upperKey.includes("API_KEY") ||
        upperKey.includes("PASSWORD")) &&
      !upperKey.startsWith("PATH") &&
      !upperKey.startsWith("NODE_")
    ) {
      if (!rulesMap.has(val.trim())) {
        rulesMap.set(val.trim(), upperKey);
      }
    }
  }

  // Convert to array and sort descending by length so longer strings match first
  return Array.from(rulesMap.entries())
    .map(([value, name]) => ({ name, value }))
    .sort((a, b) => b.value.length - a.value.length);
}

/**
 * Redacts registered secret values and AWS account numbers from a plain string.
 */
export function redactText(text: string, rules?: RedactionRule[]): string {
  if (!text || typeof text !== "string") {
    return text;
  }

  const activeRules = rules ?? parseRedactionEnv(process.env.PI_CLOUD_REDACT_ENV);

  let result = text;
  for (const rule of activeRules) {
    if (rule.value && result.includes(rule.value)) {
      const tag = rule.name ? `[REDACTED:${rule.name}]` : "[REDACTED]";
      result = result.replaceAll(rule.value, tag);
    }
  }

  // Mask AWS 12-digit account IDs
  result = maskAccountId(result);

  return result;
}

/**
 * Deep recursive redaction for objects, arrays, errors, and nested content blocks.
 */
export function redactObject<T>(
  value: T,
  rules?: RedactionRule[],
  visited = new WeakSet<object>(),
): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return redactText(value, rules) as unknown as T;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }

  if (typeof value === "function") {
    return value;
  }

  if (value instanceof Error) {
    const redactedError: Record<string, unknown> = {
      name: value.name,
      message: redactText(value.message, rules),
    };
    if (value.stack) {
      redactedError.stack = redactText(value.stack, rules);
    }
    if ("code" in value) {
      redactedError.code = (value as { code: unknown }).code;
    }
    return redactedError as unknown as T;
  }

  if (typeof value === "object") {
    if (visited.has(value)) {
      return value;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => redactObject(item, rules, visited)) as unknown as T;
    }

    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = redactObject(v, rules, visited);
    }
    return result as T;
  }

  return value;
}

/**
 * Pi in-VM Extension factory.
 * Registers interceptors on `tool_result` and `message_end` to redact all secrets before
 * they reach transcripts or LLM context.
 */
export default function (pi: ExtensionAPI): void {
  const rules = parseRedactionEnv(process.env.PI_CLOUD_REDACT_ENV);
  if (rules.length === 0) {
    return;
  }

  // biome-ignore lint/suspicious/noExplicitAny: extension lifecycle event subscription
  const untypedPi = pi as any;
  if (typeof untypedPi.on === "function") {
    // 1. Intercept tool_result events
    untypedPi.on(
      "tool_result",
      async (
        event: Record<string, unknown>,
      ): Promise<Record<string, unknown> | undefined> => {
        let modified = false;
        let newContent = event.content;
        let newDetails = event.details;

        if (event.content && Array.isArray(event.content)) {
          newContent = event.content.map((block) => {
            if (
              block &&
              typeof block === "object" &&
              "type" in block &&
              block.type === "text"
            ) {
              const textVal = (block as { text?: string }).text;
              if (typeof textVal === "string") {
                const redacted = redactText(textVal, rules);
                if (redacted !== textVal) {
                  modified = true;
                  return { ...block, text: redacted };
                }
              }
            }
            return redactObject(block, rules);
          });
        }

        if (event.details && typeof event.details === "object") {
          newDetails = redactObject(event.details, rules);
          modified = true;
        }

        if (modified) {
          return {
            content: newContent as Record<string, unknown>[],
            details: newDetails as Record<string, unknown>,
          };
        }
        return undefined;
      },
    );

    // 2. Intercept message_end events
    untypedPi.on(
      "message_end",
      async (
        event: Record<string, unknown>,
      ): Promise<Record<string, unknown> | undefined> => {
        if (event.message) {
          const redactedMsg = redactObject(event.message, rules);
          return {
            message: redactedMsg as Record<string, unknown>,
          };
        }
        return undefined;
      },
    );
  }
}
