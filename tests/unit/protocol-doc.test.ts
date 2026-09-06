import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FinalizeRequestSchema,
  InterruptRequestSchema,
  PROTOCOL_ROUTES,
  PromptRequestSchema,
  ProtocolErrorCode,
  ProtocolHeaders,
} from "../../shared/protocol.js";

describe("T1.3 Protocol Document & Contract Validation", () => {
  const protocolDocPath = path.resolve(__dirname, "../../docs/protocol.md");
  const protocolDoc = fs.readFileSync(protocolDocPath, "utf8");

  it("protocol.md exists and contains required sections", () => {
    expect(protocolDoc).toContain("# Protocol Specification (v1)");
    expect(protocolDoc).toContain("MicroVM Lifecycle Hooks");
    expect(protocolDoc).toContain("Runner HTTP & Streaming API");
    expect(protocolDoc).toContain("WebSocket RPC Passthrough");
    expect(protocolDoc).toContain("Proxy Authentication & Networking");
    expect(protocolDoc).toContain("x-aws-proxy-auth");
    expect(protocolDoc).toContain("x-aws-proxy-port");
    expect(protocolDoc).toContain("Last-Event-ID");
  });

  it("all PROTOCOL_ROUTES are documented in docs/protocol.md", () => {
    for (const route of PROTOCOL_ROUTES) {
      expect(protocolDoc).toContain(route.path);
      expect(protocolDoc).toContain(route.method);
    }
  });

  it("all ProtocolErrorCodes are documented in docs/protocol.md", () => {
    for (const code of Object.values(ProtocolErrorCode)) {
      expect(protocolDoc).toContain(`\`${code}\``);
    }
  });

  it("validates PromptRequest schema across modes", () => {
    // Standard prompt
    const promptReq = PromptRequestSchema.parse({
      prompt: "Fix failing test",
    });
    expect(promptReq.prompt).toBe("Fix failing test");
    expect(promptReq.mode).toBe("prompt");

    // Steer mode
    const steerReq = PromptRequestSchema.parse({
      prompt: "Stop and focus on file X",
      mode: "steer",
      steer: true,
    });
    expect(steerReq.mode).toBe("steer");

    // FollowUp mode with message
    const followUpReq = PromptRequestSchema.parse({
      message: "Also check lint",
      mode: "followUp",
    });
    expect(followUpReq.message).toBe("Also check lint");
    expect(followUpReq.mode).toBe("followUp");

    // Missing both prompt and message fails
    expect(() =>
      PromptRequestSchema.parse({
        mode: "prompt",
      }),
    ).toThrow();
  });

  it("validates InterruptRequest and FinalizeRequest schemas", () => {
    const interrupt = InterruptRequestSchema.parse({
      reason: "User canceled",
    });
    expect(interrupt.reason).toBe("User canceled");

    const finalize = FinalizeRequestSchema.parse({
      autoPush: true,
      commitMessage: "test commit",
    });
    expect(finalize.autoPush).toBe(true);
    expect(finalize.commitMessage).toBe("test commit");
  });

  it("validates header constants match proxy specifications", () => {
    expect(ProtocolHeaders.PROXY_AUTH).toBe("x-aws-proxy-auth");
    expect(ProtocolHeaders.PROXY_PORT).toBe("x-aws-proxy-port");
    expect(ProtocolHeaders.LAST_EVENT_ID).toBe("last-event-id");
  });
});
