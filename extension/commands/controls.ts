/**
 * Extension command handlers for cloud agent controls (T4.8).
 * Provides /cloud stop, /cloud suspend, /cloud resume, /cloud logs, /cloud pr, and /cloud shell.
 */

import {
  createCloudRunPullRequest,
  createCloudRunShellSession,
  fetchCloudRunLogs,
  resumeCloudRun,
  stopCloudRun,
  suspendCloudRun,
  tailCloudRunLogs,
} from "../../core/controls.js";
import { listCloudRuns } from "../../core/list.js";
import { PiPrompter } from "../prompter-pi.js";
import type { RouteContext, RouteResult } from "../router.js";

/**
 * Helper to resolve runId from args or prompt the user.
 */
async function getOrPromptRunId(
  subArgs: string[],
  actionName: string,
  ctx?: RouteContext,
): Promise<string | undefined> {
  let runId = subArgs.find((arg) => !arg.startsWith("-"))?.trim();

  if (!runId && ctx?.hasUI) {
    try {
      const prompter = new PiPrompter(ctx);
      const runs = await listCloudRuns({ limit: 10 });
      if (runs.length > 0) {
        const options = runs.map((r) => ({
          label: `${r.statusBadge}  ${r.runId}  ${r.repo}  ${r.cost}`,
          value: r.fullRunId,
        }));
        runId = await prompter.select(`Select a run to ${actionName}:`, options);
      }
    } catch {
      // Fall through to undefined
    }
  }

  return runId;
}

/**
 * /cloud stop <runId> [--yes] [--force]
 */
export async function handleCloudStopCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  const force = subArgs.includes("--force");
  const skipConfirm = subArgs.includes("--yes") || subArgs.includes("-y") || force;
  const runId = await getOrPromptRunId(subArgs, "stop", ctx);

  if (!runId) {
    const usageMsg = "Usage: /cloud stop <runId>\nExample: /cloud stop 7f3a2c";
    if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(usageMsg, "warning");
    return { subcommand: "stop", args: subArgs, output: usageMsg, handled: true };
  }

  try {
    if (!skipConfirm && ctx?.hasUI) {
      const prompter = new PiPrompter(ctx);
      const confirmed = await prompter.confirm(
        `Are you sure you want to stop and terminate cloud run '${runId}'?`,
        true,
      );
      if (!confirmed) {
        const cancelMsg = `Stop cancelled for run '${runId}'.`;
        if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(cancelMsg, "info");
        return { subcommand: "stop", args: subArgs, output: cancelMsg, handled: true };
      }
    }

    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(`Stopping run '${runId}'...`, "info");
    }

    const result = await stopCloudRun(runId, { force });
    const output = `✓ ${result.message}`;

    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(output, "info");
    }

    return { subcommand: "stop", args: subArgs, output, handled: true };
  } catch (err: unknown) {
    const errorMsg = `Failed to stop run '${runId}': ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(errorMsg, "error");
    return { subcommand: "stop", args: subArgs, output: errorMsg, handled: true };
  }
}

/**
 * /cloud suspend <runId>
 */
export async function handleCloudSuspendCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  const runId = await getOrPromptRunId(subArgs, "suspend", ctx);

  if (!runId) {
    const usageMsg = "Usage: /cloud suspend <runId>\nExample: /cloud suspend 7f3a2c";
    if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(usageMsg, "warning");
    return { subcommand: "suspend", args: subArgs, output: usageMsg, handled: true };
  }

  try {
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(`Suspending MicroVM for run '${runId}'...`, "info");
    }

    const result = await suspendCloudRun(runId);
    const output = `✓ ${result.message}`;

    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(output, "info");
    }

    return { subcommand: "suspend", args: subArgs, output, handled: true };
  } catch (err: unknown) {
    const errorMsg = `Failed to suspend run '${runId}': ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(errorMsg, "error");
    return { subcommand: "suspend", args: subArgs, output: errorMsg, handled: true };
  }
}

/**
 * /cloud resume <runId>
 */
export async function handleCloudResumeCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  const runId = await getOrPromptRunId(subArgs, "resume", ctx);

  if (!runId) {
    const usageMsg = "Usage: /cloud resume <runId>\nExample: /cloud resume 7f3a2c";
    if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(usageMsg, "warning");
    return { subcommand: "resume", args: subArgs, output: usageMsg, handled: true };
  }

  try {
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(`Resuming MicroVM for run '${runId}'...`, "info");
    }

    const result = await resumeCloudRun(runId);
    const output = `✓ ${result.message}`;

    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(output, "info");
    }

    return { subcommand: "resume", args: subArgs, output, handled: true };
  } catch (err: unknown) {
    const errorMsg = `Failed to resume run '${runId}': ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(errorMsg, "error");
    return { subcommand: "resume", args: subArgs, output: errorMsg, handled: true };
  }
}

/**
 * /cloud logs <runId> [--follow] [--lines <n>]
 */
export async function handleCloudLogsCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  const follow = subArgs.includes("--follow") || subArgs.includes("-f");
  const runId = await getOrPromptRunId(subArgs, "view logs", ctx);

  if (!runId) {
    const usageMsg = "Usage: /cloud logs <runId> [--follow]\nExample: /cloud logs 7f3a2c --follow";
    if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(usageMsg, "warning");
    return { subcommand: "logs", args: subArgs, output: usageMsg, handled: true };
  }

  try {
    if (follow) {
      const startNotice = `Streaming CloudWatch logs for run '${runId}' (polling every 2s)...`;
      if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(startNotice, "info");

      tailCloudRunLogs(runId, (evt) => {
        if (ctx?.hasUI && ctx.ui?.notify) {
          ctx.ui.notify(`[${evt.formattedTime}] ${evt.message}`, "info");
        }
      });

      return {
        subcommand: "logs",
        args: subArgs,
        output: startNotice,
        handled: true,
      };
    }

    const logResult = await fetchCloudRunLogs(runId);

    const lines: string[] = [];
    lines.push(
      `CloudWatch logs for run '${logResult.runId}' (log group: ${logResult.logGroupName}):`,
    );
    lines.push("");

    if (logResult.events.length === 0) {
      lines.push("No log events found for this run.");
    } else {
      for (const evt of logResult.events) {
        lines.push(`[${evt.formattedTime}] ${evt.message}`);
      }
    }

    const output = lines.join("\n");
    if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(output, "info");

    return { subcommand: "logs", args: subArgs, output, handled: true };
  } catch (err: unknown) {
    const errorMsg = `Failed to fetch logs for run '${runId}': ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(errorMsg, "error");
    return { subcommand: "logs", args: subArgs, output: errorMsg, handled: true };
  }
}

/**
 * /cloud pr <runId> [title]
 */
export async function handleCloudPrCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  const runId = await getOrPromptRunId(subArgs, "create PR", ctx);

  if (!runId) {
    const usageMsg =
      "Usage: /cloud pr <runId> [title]\nExample: /cloud pr 7f3a2c Add OAuth support";
    if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(usageMsg, "warning");
    return { subcommand: "pr", args: subArgs, output: usageMsg, handled: true };
  }

  // Extract title if provided
  const titleParts = subArgs.filter((a) => a !== runId && !a.startsWith("-"));
  const title = titleParts.length > 0 ? titleParts.join(" ") : undefined;

  try {
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(`Preparing pull request for run '${runId}'...`, "info");
    }

    const result = await createCloudRunPullRequest(runId, { title });

    const lines: string[] = [];
    lines.push(`✓ ${result.message}`);
    lines.push(`Work branch: ${result.workBranch} → ${result.baseBranch}`);

    if (result.prUrl) {
      lines.push(`Pull request: ${result.prUrl}`);
    } else if (result.manualCommands && result.manualCommands.length > 0) {
      lines.push("");
      lines.push("Commands to publish and create PR manually:");
      for (const cmd of result.manualCommands) {
        lines.push(`  ${cmd}`);
      }
    }

    const output = lines.join("\n");
    if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(output, "info");

    return { subcommand: "pr", args: subArgs, output, handled: true };
  } catch (err: unknown) {
    const errorMsg = `Failed to create pull request for run '${runId}': ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(errorMsg, "error");
    return { subcommand: "pr", args: subArgs, output: errorMsg, handled: true };
  }
}

/**
 * /cloud shell <runId>
 */
export async function handleCloudShellCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  const runId = await getOrPromptRunId(subArgs, "open shell in", ctx);

  if (!runId) {
    const usageMsg = "Usage: /cloud shell <runId>\nExample: /cloud shell 7f3a2c";
    if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(usageMsg, "warning");
    return { subcommand: "shell", args: subArgs, output: usageMsg, handled: true };
  }

  try {
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(
        `Minting interactive shell token for run '${runId}' (expires in 15m)...`,
        "info",
      );
    }

    const sessionInfo = await createCloudRunShellSession(runId);

    const lines: string[] = [
      `Interactive shell session ready for run '${runId}' (experimental):`,
      `MicroVM:   ${sessionInfo.microvmId}`,
      `Endpoint:  ${sessionInfo.endpoint}:${sessionInfo.port}`,
      "Protocol:  WebSocket (port 8022 subprotocol)",
      "Expires:   In 15 minutes",
      "",
      "WebSocket connection URL:",
      `  ${sessionInfo.wsUrl}`,
      "",
      "Notice: Shell access is secured with expiring token authentication.",
    ];

    const output = lines.join("\n");
    if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(output, "info");

    return { subcommand: "shell", args: subArgs, output, handled: true };
  } catch (err: unknown) {
    const errorMsg = `Failed to open shell for run '${runId}': ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) ctx.ui.notify(errorMsg, "error");
    return { subcommand: "shell", args: subArgs, output: errorMsg, handled: true };
  }
}
