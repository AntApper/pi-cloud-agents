/**
 * Property-based and fuzz testing for Protocol and Manifest parsers (T5.7).
 */

import { describe, expect, it } from "vitest";
import {
  type LaunchPayload,
  LaunchPayloadSchema,
  decodeLaunchPayload,
  encodeLaunchPayload,
} from "../../shared/protocol.js";

describe("T5.7 Protocol Parser Fuzz Testing and Boundary Validation", () => {
  const validPayload: LaunchPayload = {
    v: 1,
    runId: "run-20260906-valid01",
    owner: "user-ant",
    stack: {
      name: "pi-cloud-agents-core",
      region: "us-east-1",
      bucket: "pi-cloud-agents-bucket",
    },
    repo: {
      url: "https://github.com/acme/api.git",
      workBranch: "pi-cloud/valid01",
    },
    model: {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
    },
    piConfig: {
      bundleKey: "config/bundle.tar",
      authParams: ["anthropic"],
      bedrockRole: false,
    },
    github: {
      mode: "none",
    },
    options: {
      installTimeoutSec: 300,
      trustProjectConfig: true,
      idleGraceSec: 600,
      suspendAfterIdleSec: 900,
      terminateAfterSuspendedSec: 7200,
      autoPush: false,
      maxDurationSec: 14400,
    },
    logGroup: "/aws/lambda/microvms/runner",
  };

  it("handles randomized invalid JSON payloads without unhandled exceptions", () => {
    const corruptInputs = [
      "",
      "null",
      "undefined",
      "{",
      '{"v": 2}',
      '{"v": 1, "runId": "invalid_chars_$$$"}',
      JSON.stringify({
        ...validPayload,
        options: { ...validPayload.options, maxDurationSec: 50000 },
      }),
      "A".repeat(10000),
      "\x00\x01\x02\x03",
    ];

    for (const input of corruptInputs) {
      expect(() => decodeLaunchPayload(input)).toThrow();
    }
  });

  it("round-trips valid encoded payloads without data loss", () => {
    const encoded = encodeLaunchPayload(validPayload);
    const decoded = decodeLaunchPayload(encoded);

    expect(decoded.runId).toBe(validPayload.runId);
    expect(decoded.model.provider).toBe(validPayload.model.provider);
    expect(decoded.options.maxDurationSec).toBe(validPayload.options.maxDurationSec);
  });

  it("rejects runId violating safe regex pattern", () => {
    const invalidRunIds = ["RUN_CAPS", "run with spaces", "run/slash", "run;semicolon", ""];

    for (const id of invalidRunIds) {
      expect(() =>
        LaunchPayloadSchema.parse({
          ...validPayload,
          runId: id,
        }),
      ).toThrow();
    }
  });
});
