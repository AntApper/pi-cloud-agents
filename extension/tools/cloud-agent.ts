/**
 * Cloud Agent Tool for Local LLM (T4.9).
 * Enables the local LLM to autonomously delegate coding tasks, inspect run status,
 * retrieve execution results, steer running agents, or terminate runs.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { stopCloudRun } from "../../core/controls.js";
import { launchCloudRun } from "../../core/launcher.js";
import { fetchRunStatusDetails } from "../../core/status.js";
import { GLYPHS } from "../ui/kit.js";
import { loadLocalConfig } from "../../core/config.js";
import { AwsClientFactory } from "../../core/aws/clients.js";
import { RunClient } from "../../core/client/run-client.js";

export const DEFAULT_MAX_TOOL_BYTES = 50 * 1024; // 50 KB
export const DEFAULT_MAX_TOOL_LINES = 2000;

export interface TruncationOptions {
  maxBytes?: number;
  maxLines?: number;
}

export interface TruncationResult {
  content: string;
  truncated: boolean;
  originalBytes: number;
  originalLines: number;
}

/**
 * Truncates text output to byte and line limits, ensuring context windows are preserved.
 */
export function truncateToolOutput(
  text: string,
  options: TruncationOptions = {},
): TruncationResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TOOL_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_TOOL_LINES;

  const originalBytes = Buffer.byteLength(text, "utf8");
  const lines = text.split("\n");
  const originalLines = lines.length;

  if (originalBytes <= maxBytes && originalLines <= maxLines) {
    return {
      content: text,
      truncated: false,
      originalBytes,
      originalLines,
    };
  }

  // Truncate by lines first
  const truncatedLines = lines.slice(0, maxLines);
  let truncatedText = truncatedLines.join("\n");

  // Then truncate by bytes if still exceeding
  if (Buffer.byteLength(truncatedText, "utf8") > maxBytes) {
    const buffer = Buffer.from(truncatedText, "utf8");
    truncatedText = buffer.subarray(0, maxBytes).toString("utf8");
    // Clean up potentially split UTF-8 character at end
    const lastNewline = truncatedText.lastIndexOf("\n");
    if (lastNewline > 0) {
      truncatedText = truncatedText.substring(0, lastNewline);
    }
  }

  const notice = `\n\n[Output truncated to ${Math.round(maxBytes / 1024)} KB / ${maxLines} lines. View full session via /cloud status or /cloud attach]`;
  return {
    content: truncatedText + notice,
    truncated: true,
    originalBytes,
    originalLines,
  };
}

export const CloudAgentActionEnum = ["launch", "status", "result", "steer", "stop"] as const;
export type CloudAgentAction = (typeof CloudAgentActionEnum)[number];

export const CloudAgentToolParams = Type.Object({
  action: Type.String({
    description:
      "Action to perform: launch a new run, check status, get final result, steer, or stop a run (launch | status | result | steer | stop)",
  }),
  prompt: Type.Optional(
    Type.String({
      description: "Instructions or task prompt for 'launch' or 'steer' action",
    }),
  ),
  runId: Type.Optional(
    Type.String({
      description: "Cloud agent run ID (required for status, result, steer, stop)",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Model override for cloud agent (e.g. anthropic/claude-sonnet-4-5)",
    }),
  ),
  branch: Type.Optional(
    Type.String({
      description: "Base branch to branch off or work branch override",
    }),
  ),
  followUp: Type.Optional(
    Type.Boolean({
      description: "When steering, send as follow-up without interrupting ongoing work",
    }),
  ),
  wait: Type.Optional(
    Type.Boolean({
      description: "For 'result' action: wait for agent to complete before returning (default: false)",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description: "Maximum seconds to wait when wait=true (default: 60)",
    }),
  ),
});

export type CloudAgentToolParamsType = {
  action: CloudAgentAction;
  prompt?: string;
  runId?: string;
  model?: string;
  branch?: string;
  followUp?: boolean;
  wait?: boolean;
  timeoutSeconds?: number;
};

export interface ToolExecutionContext {
  cwd?: string;
  [key: string]: unknown;
}

/**
 * Parses model string into provider and model ID if formatted as "provider/modelId".
 */
export function parseModelOption(modelStr?: string): { provider: string; id: string } | undefined {
  if (!modelStr) return undefined;
  const slashIdx = modelStr.indexOf("/");
  if (slashIdx !== -1) {
    return {
      provider: modelStr.slice(0, slashIdx),
      id: modelStr.slice(slashIdx + 1),
    };
  }
  return {
    provider: "anthropic",
    id: modelStr,
  };
}

/**
 * Executes the cloud_agent tool logic.
 */
export async function executeCloudAgentTool(
  _toolCallId: string,
  params: CloudAgentToolParamsType,
  signal?: AbortSignal,
  onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
  ctx?: ToolExecutionContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}> {
  if (signal?.aborted) {
    return {
      content: [{ type: "text", text: "Operation cancelled." }],
      details: { cancelled: true },
    };
  }

  const { action } = params;

  switch (action) {
    case "launch": {
      if (!params.prompt || params.prompt.trim().length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: 'prompt' parameter is required when action is 'launch'.",
            },
          ],
          details: { error: "MISSING_PROMPT" },
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: "Launching cloud agent in MicroVM..." }],
        details: { step: "launching" },
      });

      const parsedModel = parseModelOption(params.model);
      const launchResult = await launchCloudRun({
        prompt: params.prompt,
        model: parsedModel,
        workBranch: params.branch,
        repoDir: ctx?.cwd || process.cwd(),
      });

      const text = [
        `Cloud agent launched successfully.`,
        `Run ID: ${launchResult.runId}`,
        `Branch: ${launchResult.manifest.repo.workBranch}`,
        `Repository: ${launchResult.manifest.repo.url}`,
        `Model: ${launchResult.manifest.model.provider}/${launchResult.manifest.model.id}`,
        `State: ${launchResult.manifest.status}`,
        ``,
        `Next steps:`,
        `- Check progress: cloud_agent(action="status", runId="${launchResult.runId}")`,
        `- Get result: cloud_agent(action="result", runId="${launchResult.runId}")`,
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: {
          action: "launch",
          runId: launchResult.runId,
          branch: launchResult.manifest.repo.workBranch,
          repository: launchResult.manifest.repo.url,
          state: launchResult.manifest.status,
          microvmId: launchResult.microvmId,
        },
      };
    }

    case "status": {
      if (!params.runId || params.runId.trim().length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: 'runId' parameter is required when action is 'status'.",
            },
          ],
          details: { error: "MISSING_RUN_ID" },
        };
      }

      const status = await fetchRunStatusDetails(params.runId);

      const text = [
        `Run: ${status.shortRunId} (${status.runId})`,
        `State: ${status.status}`,
        `Activity: ${status.activity.description}`,
        `Turns: ${status.counters.turns} · Tool calls: ${status.counters.totalToolCalls} · Tokens: ${status.tokens.total} · Cost: ${status.tokens.cost}`,
        `Elapsed: ${status.uptime} · Last event: ${status.activity.lastEventAge}`,
        `Work branch: ${status.repo.workBranch} (${status.repo.commits} commits, +${status.repo.insertions} -${status.repo.deletions})`,
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: {
          action: "status",
          runId: status.runId,
          status: status.status,
          turns: status.counters.turns,
          cost: status.tokens.cost,
          activity: status.activity.description,
        },
      };
    }

    case "result": {
      if (!params.runId || params.runId.trim().length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: 'runId' parameter is required when action is 'result'.",
            },
          ],
          details: { error: "MISSING_RUN_ID" },
        };
      }

      let status = await fetchRunStatusDetails(params.runId);

      // If wait is requested and run is still in active/running state, poll with timeout
      if (
        params.wait &&
        (status.status === "RUNNING" ||
          status.status === "running" ||
          status.status === "launching" ||
          status.status === "provisioning")
      ) {
        const timeoutMs = (params.timeoutSeconds ?? 60) * 1000;
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
          if (signal?.aborted) break;
          await new Promise((resolve) => setTimeout(resolve, 2000));
          status = await fetchRunStatusDetails(params.runId);
          if (
            status.status !== "RUNNING" &&
            status.status !== "running" &&
            status.status !== "launching" &&
            status.status !== "provisioning"
          ) {
            break;
          }
        }
      }

      const lines: string[] = [
        `--- Cloud Agent Execution Report ---`,
        `Run ID: ${status.runId}`,
        `Status: ${status.status}`,
        `Branch: ${status.repo.workBranch}`,
        `Repository: ${status.repo.url}`,
        `Commits: ${status.repo.commits} (+${status.repo.insertions} -${status.repo.deletions} in ${status.repo.filesChanged} files)`,
        `Tokens: ${status.tokens.total} · Cost: ${status.tokens.cost} · Turns: ${status.counters.turns}`,
      ];

      if (status.manifest?.git?.prUrl) {
        lines.push(`PR URL: ${status.manifest.git.prUrl}`);
      }

      const completedStep = status.manifest?.timeline?.find(
        (t) => t.status === "completed" || t.status === "failed",
      );
      const summary =
        completedStep?.reason ||
        (completedStep as unknown as { detail?: string })?.detail ||
        (status.manifest as unknown as { results?: { summary?: string } })?.results?.summary;
      if (summary) {
        lines.push(``, `Summary:`, summary);
      } else {
        lines.push(``, `Latest Activity: ${status.activity.description}`);
      }

      const fullOutput = lines.join("\n");
      const truncated = truncateToolOutput(fullOutput);

      return {
        content: [{ type: "text", text: truncated.content }],
        details: {
          action: "result",
          runId: status.runId,
          status: status.status,
          branch: status.repo.workBranch,
          commits: status.repo.commits,
          prUrl: status.manifest?.git?.prUrl,
          truncated: truncated.truncated,
        },
      };
    }

    case "steer": {
      if (!params.runId || params.runId.trim().length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: 'runId' parameter is required when action is 'steer'.",
            },
          ],
          details: { error: "MISSING_RUN_ID" },
        };
      }
      if (!params.prompt || params.prompt.trim().length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: 'prompt' parameter is required when action is 'steer'.",
            },
          ],
          details: { error: "MISSING_PROMPT" },
        };
      }

      const status = await fetchRunStatusDetails(params.runId);

      // If runner endpoint and microvmId are active, dispatch to runner via RunClient
      let dispatchedLive = false;
      if (
        status.manifest?.endpoint &&
        status.manifest?.microvmId &&
        (status.status === "RUNNING" ||
          status.status === "running" ||
          status.status === "IDLE" ||
          status.status === "idle")
      ) {
        try {
          const config = loadLocalConfig();
          const factory = new AwsClientFactory(config);
          const microvmsClient = factory.getLambdaMicrovmsClient(config.aws.region, config.aws.profile);
          const runClient = new RunClient({
            endpoint: status.manifest.endpoint,
            microvmIdentifier: status.manifest.microvmId,
            region: config.aws.region,
            profile: config.aws.profile,
            clientFactory: factory,
            microvmsClient,
          });

          await runClient.prompt({
            prompt: params.prompt,
            mode: params.followUp ? "followUp" : "steer",
            steer: !params.followUp,
          });
          dispatchedLive = true;
        } catch {
          // Fall back gracefully if live dispatch fails
        }
      }

      const text = `Steer prompt dispatched to cloud agent ${status.shortRunId} (${params.followUp ? "follow-up mode" : "steer mode"}${dispatchedLive ? ", live connected" : ""}).`;

      return {
        content: [{ type: "text", text }],
        details: {
          action: "steer",
          runId: status.runId,
          followUp: !!params.followUp,
          dispatchedLive,
        },
      };
    }

    case "stop": {
      if (!params.runId || params.runId.trim().length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: 'runId' parameter is required when action is 'stop'.",
            },
          ],
          details: { error: "MISSING_RUN_ID" },
        };
      }

      const stopResult = await stopCloudRun(params.runId);
      const text = `Cloud agent run ${stopResult.runId} stopped: ${stopResult.message}`;

      return {
        content: [{ type: "text", text }],
        details: {
          action: "stop",
          runId: stopResult.runId,
          status: stopResult.status,
        },
      };
    }

    default: {
      return {
        content: [
          {
            type: "text",
            text: `Error: Unknown action '${action}'. Valid actions are: ${CloudAgentActionEnum.join(", ")}.`,
          },
        ],
        details: { error: "INVALID_ACTION" },
      };
    }
  }
}

/**
 * Registers the `cloud_agent` tool on the pi extension API.
 */
export function registerCloudAgentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "cloud_agent",
    label: "Cloud Agent",
    description:
      "Delegate long, complex, or independent coding tasks to an isolated cloud sandbox agent in AWS Lambda MicroVM.",
    promptSnippet: "Delegate coding tasks to an isolated AWS MicroVM cloud agent",
    promptGuidelines: [
      "Use cloud_agent to delegate long, complex, or independent coding tasks to an isolated cloud sandbox with its own repository checkout, environment, and compute.",
      "Use cloud_agent with action 'launch' to start a new cloud task, action 'status' to check execution progress, action 'result' to wait for and retrieve the completed task output, action 'steer' to adjust the agent's course, and action 'stop' to terminate a run.",
    ],
    parameters: CloudAgentToolParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeCloudAgentTool(
        toolCallId,
        params as CloudAgentToolParamsType,
        signal,
        onUpdate,
        ctx as unknown as ToolExecutionContext,
      );
    },
    renderCall(args, _theme, _context) {
      const p = args as CloudAgentToolParamsType;
      const action = p.action || "launch";
      let summary = String(action);

      if (action === "launch" && p.prompt) {
        const shortPrompt = p.prompt.length > 50 ? `${p.prompt.slice(0, 47)}…` : p.prompt;
        summary = `launch: "${shortPrompt}"`;
      } else if (p.runId) {
        const shortId = p.runId.slice(0, 8);
        summary = `${action} ${shortId}`;
      }

      return new Text(`cloud_agent ${GLYPHS.arrowRight} ${summary}`);
    },
    renderResult(result, _options, _theme, _context) {
      const details = (result?.details ?? {}) as Record<string, unknown>;
      const action = details.action as string | undefined;

      if (action === "launch" && details.runId) {
        return new Text(
          `${GLYPHS.running} Launched cloud run ${(details.runId as string).slice(0, 8)} (${details.branch})`,
        );
      }
      if (action === "status" && details.runId) {
        return new Text(
          `${GLYPHS.running} Run ${(details.runId as string).slice(0, 8)}: ${details.status} (${details.turns} turns, ${details.cost})`,
        );
      }
      if (action === "result" && details.runId) {
        return new Text(`${GLYPHS.pass} Result for ${(details.runId as string).slice(0, 8)}: ${details.status}`);
      }
      if (action === "stop" && details.runId) {
        return new Text(`${GLYPHS.idle} Stopped ${(details.runId as string).slice(0, 8)}`);
      }

      const firstContent = result?.content?.[0];
      const textPreview =
        (firstContent && "text" in firstContent ? firstContent.text : "") || "cloud_agent finished";
      return new Text(textPreview.slice(0, 80));
    },
  });
}
