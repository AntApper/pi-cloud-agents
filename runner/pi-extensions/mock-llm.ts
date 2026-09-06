/**
 * Mock LLM Provider Extension for pi-cloud-agents (T0.5 / local testing / smoke runs).
 * Registers a zero-cost custom provider "mock-llm" with model "scripted".
 *
 * Plays a deterministic 2-turn script:
 *  - Turn 1: Emits an assistant message with a bash tool call: `echo hello > hello.txt`
 *  - Turn 2: Upon receiving the tool result, emits the assistant message: `Done: created hello.txt`
 */

import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ToolCall,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MOCK_PROVIDER_ID = "mock-llm";
export const MOCK_MODEL_ID = "scripted";
export const SCRIPTED_TOOL_COMMAND = "echo hello > hello.txt";
export const SCRIPTED_FINAL_RESPONSE = "Done: created hello.txt";

export function streamMockLlm(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    try {
      if (options?.signal?.aborted) {
        throw new Error("Stream aborted");
      }

      stream.push({ type: "start", partial: output });

      // Check message history to determine turn phase
      const hasToolResult = context.messages.some(
        (msg) => msg.role === "toolResult" || (msg.role as string) === "tool_result",
      );

      if (!hasToolResult) {
        // Turn 1: Emit assistant message with bash tool call
        const toolCallId = `call_mock_bash_${Date.now()}`;
        const args = { command: SCRIPTED_TOOL_COMMAND };
        const toolCall: ToolCall = {
          type: "toolCall",
          id: toolCallId,
          name: "bash",
          arguments: args,
        };

        output.content.push(toolCall);
        stream.push({
          type: "toolcall_start",
          contentIndex: 0,
          partial: output,
        });
        stream.push({
          type: "toolcall_delta",
          contentIndex: 0,
          delta: JSON.stringify(args),
          partial: output,
        });
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall,
          partial: output,
        });

        output.stopReason = "toolUse";
      } else {
        // Turn 2: Emit final text response
        const text = SCRIPTED_FINAL_RESPONSE;
        const textBlock: TextContent = {
          type: "text",
          text,
        };

        output.content.push(textBlock);
        stream.push({
          type: "text_start",
          contentIndex: 0,
          partial: output,
        });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: text,
          partial: output,
        });
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: text,
          partial: output,
        });

        output.stopReason = "stop";
      }

      stream.push({
        type: "done",
        reason: output.stopReason,
        message: output,
      });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({
        type: "error",
        reason: output.stopReason,
        error: output,
      });
      stream.end();
    }
  })();

  return stream;
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider(MOCK_PROVIDER_ID, {
    name: "Mock LLM Provider (Zero Cost Scripted)",
    baseUrl: "mock://localhost",
    apiKey: "mock-key",
    api: "mock-llm-api",
    models: [
      {
        id: MOCK_MODEL_ID,
        name: "Scripted Mock Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    streamSimple: streamMockLlm,
  });
}
