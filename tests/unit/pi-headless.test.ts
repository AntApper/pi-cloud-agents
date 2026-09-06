import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantMessageEvent, Context, Model, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  PINNED_PI_VERSION,
  formatPiHeadlessTable,
  isArm64Architecture,
  isNodeVersionValid,
  runPiHeadlessProcess,
  runPiHeadlessSpike,
  simulatePiHeadlessExecution,
  validateDockerfile,
} from "../../core/aws/pi-headless.js";
import mockLlmExtension, {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  SCRIPTED_FINAL_RESPONSE,
  SCRIPTED_TOOL_COMMAND,
  streamMockLlm,
} from "../../runner/pi-extensions/mock-llm.js";

describe("T0.5 Pi Headless & Mock LLM Provider Spike", () => {
  describe("image/Dockerfile v0 Validation", () => {
    it("validates the real image/Dockerfile against AL2023 ARM64 requirements", () => {
      const dockerfilePath = path.resolve(process.cwd(), "image", "Dockerfile");
      expect(fs.existsSync(dockerfilePath)).toBe(true);

      const content = fs.readFileSync(dockerfilePath, "utf8");
      const result = validateDockerfile(content);

      expect(result.valid).toBe(true);
      expect(result.hasBaseImage).toBe(true);
      expect(result.hasNode22).toBe(true);
      expect(result.hasRequiredPackages).toBe(true);
      expect(result.hasPinnedPiVersion).toBe(true);
      expect(result.hasDirectoryStructure).toBe(true);
      expect(result.hasHookPortEnv).toBe(true);
      expect(result.hasWorkdir).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects invalid Dockerfile configurations with clear diagnostics", () => {
      const badDockerfile = `
FROM ubuntu:latest
RUN apt-get update && apt-get install -y nodejs
WORKDIR /app
`;
      const result = validateDockerfile(badDockerfile);
      expect(result.valid).toBe(false);
      expect(result.hasBaseImage).toBe(false);
      expect(result.hasNode22).toBe(false);
      expect(result.hasRequiredPackages).toBe(false);
      expect(result.hasPinnedPiVersion).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("Node Version & Architecture Validation", () => {
    it("validates Node.js version boundary (>= 22.19)", () => {
      expect(isNodeVersionValid("v22.19.0")).toBe(true);
      expect(isNodeVersionValid("22.19.0")).toBe(true);
      expect(isNodeVersionValid("v22.20.1")).toBe(true);
      expect(isNodeVersionValid("v26.8.1")).toBe(true);

      expect(isNodeVersionValid("v22.18.9")).toBe(false);
      expect(isNodeVersionValid("v20.18.0")).toBe(false);
      expect(isNodeVersionValid("v18.20.0")).toBe(false);
    });

    it("validates ARM64 CPU architecture targets", () => {
      expect(isArm64Architecture("aarch64")).toBe(true);
      expect(isArm64Architecture("arm64")).toBe(true);
      expect(isArm64Architecture("AARCH64")).toBe(true);
      expect(isArm64Architecture("ARM64")).toBe(true);

      expect(isArm64Architecture("x86_64")).toBe(false);
      expect(isArm64Architecture("x64")).toBe(false);
      expect(isArm64Architecture("ia32")).toBe(false);
    });
  });

  describe("runner/pi-extensions/mock-llm.ts Provider", () => {
    it("exports standard mock provider constants", () => {
      expect(MOCK_PROVIDER_ID).toBe("mock-llm");
      expect(MOCK_MODEL_ID).toBe("scripted");
      expect(SCRIPTED_TOOL_COMMAND).toBe("echo hello > hello.txt");
      expect(SCRIPTED_FINAL_RESPONSE).toBe("Done: created hello.txt");
    });

    it("registers provider with pi ExtensionAPI", () => {
      let registeredName = "";
      interface RegisteredModel {
        id: string;
        cost: { input: number; output: number };
      }
      interface RegisteredConfig {
        models: RegisteredModel[];
        streamSimple: unknown;
      }
      let registeredConfig: RegisteredConfig | null = null;

      const fakePi = {
        registerProvider: (name: string, config: unknown) => {
          registeredName = name;
          registeredConfig = config as RegisteredConfig;
        },
      } as unknown as ExtensionAPI;

      mockLlmExtension(fakePi);

      expect(registeredName).toBe(MOCK_PROVIDER_ID);
      expect(registeredConfig).not.toBeNull();
      if (registeredConfig) {
        const config = registeredConfig as RegisteredConfig;
        expect(config.models).toHaveLength(1);
        expect(config.models[0]?.id).toBe(MOCK_MODEL_ID);
        expect(config.models[0]?.cost.input).toBe(0);
        expect(config.models[0]?.cost.output).toBe(0);
        expect(typeof config.streamSimple).toBe("function");
      }
    });

    it("plays deterministic Turn 1 (tool call) when no tool result exists", async () => {
      const model: Model<"mock-api"> = {
        api: "mock-api",
        provider: MOCK_PROVIDER_ID,
        id: MOCK_MODEL_ID,
        name: "Scripted Mock Model",
        baseUrl: "mock://localhost",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      };

      const userMessage: UserMessage = { role: "user", content: "hello", timestamp: Date.now() };
      const context: Context = {
        messages: [userMessage],
      };

      const stream = streamMockLlm(model, context);
      const events: AssistantMessageEvent[] = [];
      for await (const ev of stream) {
        events.push(ev);
      }

      const finalMsg = await stream.result();
      expect(finalMsg.role).toBe("assistant");
      expect(finalMsg.stopReason).toBe("toolUse");
      expect(finalMsg.content).toHaveLength(1);
      const firstBlock = finalMsg.content[0];
      expect(firstBlock?.type).toBe("toolCall");
      if (firstBlock && firstBlock.type === "toolCall") {
        expect(firstBlock.name).toBe("bash");
        expect(firstBlock.arguments.command).toBe("echo hello > hello.txt");
      }
    });

    it("plays deterministic Turn 2 (text completion) when tool result exists", async () => {
      const model: Model<"mock-api"> = {
        api: "mock-api",
        provider: MOCK_PROVIDER_ID,
        id: MOCK_MODEL_ID,
        name: "Scripted Mock Model",
        baseUrl: "mock://localhost",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      };

      const context: Context = {
        messages: [
          { role: "user", content: "hello", timestamp: Date.now() },
          {
            role: "assistant",
            api: "mock-api",
            provider: MOCK_PROVIDER_ID,
            model: MOCK_MODEL_ID,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: Date.now(),
            content: [
              {
                type: "toolCall",
                id: "c1",
                name: "bash",
                arguments: { command: "echo hello > hello.txt" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "bash",
            content: [{ type: "text", text: "" }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
      };

      const stream = streamMockLlm(model, context);
      const events: AssistantMessageEvent[] = [];
      for await (const ev of stream) {
        events.push(ev);
      }

      const finalMsg = await stream.result();
      expect(finalMsg.role).toBe("assistant");
      expect(finalMsg.stopReason).toBe("stop");
      expect(finalMsg.content).toHaveLength(1);
      const firstBlock = finalMsg.content[0];
      expect(firstBlock?.type).toBe("text");
      if (firstBlock && firstBlock.type === "text") {
        expect(firstBlock.text).toBe("Done: created hello.txt");
      }
    });
  });

  describe("RPC Execution Simulation & Real Headless Process", () => {
    it("simulates RPC execution and generates verified output", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sim-test-"));
      try {
        const result = await simulatePiHeadlessExecution({ workspaceDir: tempDir });
        expect(result.success).toBe(true);
        expect(result.toolExecutionStartSeen).toBe(true);
        expect(result.toolExecutionEndSeen).toBe(true);
        expect(result.agentSettledSeen).toBe(true);
        expect(result.fileCreated).toBe(true);
        expect(result.fileContent).toBe("hello");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("runs live headless pi process with mock-llm extension and verifies hello.txt creation", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-proc-test-"));
      const extensionPath = path.resolve(process.cwd(), "runner", "pi-extensions", "mock-llm.ts");

      try {
        const result = await runPiHeadlessProcess({
          workspaceDir: tempDir,
          extensionPath,
          timeoutMs: 15000,
        });

        expect(result.success).toBe(true);
        expect(result.toolExecutionEndSeen).toBe(true);
        expect(result.agentSettledSeen).toBe(true);
        expect(result.fileCreated).toBe(true);
        expect(result.fileContent).toBe("hello");
        expect(result.finalAssistantText).toBe("Done: created hello.txt");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }, 20000);
  });

  describe("Overall Spike Runner & Formatter", () => {
    it("executes full T0.5 spike in simulation mode and produces PASS report", async () => {
      const report = await runPiHeadlessSpike({
        region: "us-east-1",
        simulate: true,
      });

      expect(report.verdict).toBe("PASS");
      expect(report.environment.piVersion).toBe(PINNED_PI_VERSION);
      expect(report.environment.piVersionMatch).toBe(true);
      expect(report.environment.nodeVersionValid).toBe(true);
      expect(report.environment.dockerfileValid).toBe(true);
      expect(report.rpcEvents.toolExecutionEndSeen).toBe(true);
      expect(report.rpcEvents.agentSettledSeen).toBe(true);
      expect(report.fileVerification.matchesExpected).toBe(true);
      expect(report.cleanupStatus).toBe("CLEANED");

      const table = formatPiHeadlessTable(report);
      expect(table).toContain("Pi Headless & Mock LLM Spike (T0.5)");
      expect(table).toContain("Verdict: SUCCESS");
      expect(table).toContain("✓ PASS");
      expect(table).not.toContain("✗ FAIL");
    });
  });
});
