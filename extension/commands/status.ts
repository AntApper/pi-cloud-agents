/**
 * Extension command handler for `/cloud status <runId>`.
 * Renders the full telemetry detail card per 07-ux-and-observability.md §2.3.
 */

import { listCloudRuns } from "../../core/list.js";
import { fetchRunStatusDetails, formatRunStatusCard } from "../../core/status.js";
import { PiPrompter } from "../prompter-pi.js";
import type { RouteContext, RouteResult } from "../router.js";

export async function handleCloudStatusCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  const jsonMode = subArgs.includes("--json");
  let runId = subArgs.find((arg) => !arg.startsWith("-"))?.trim();

  // If no runId supplied, prompt user to select from active/recent runs if UI available
  if (!runId && ctx?.hasUI) {
    try {
      const prompter = new PiPrompter(ctx);
      const runs = await listCloudRuns({ limit: 10 });
      if (runs.length > 0) {
        const options = runs.map((r) => ({
          label: `${r.statusBadge}  ${r.runId}  ${r.repo}  ${r.cost}`,
          value: r.fullRunId,
        }));
        runId = await prompter.select("Select a run to view status:", options);
      }
    } catch {
      // Fall through to usage message
    }
  }

  if (!runId) {
    const errorMsg =
      "Usage: /cloud status <runId>\nExample: /cloud status 7f3a2c\nRun '/cloud list' to see active runs.";
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(errorMsg, "warning");
    }
    return {
      subcommand: "status",
      args: subArgs,
      output: errorMsg,
      handled: true,
    };
  }

  try {
    const details = await fetchRunStatusDetails(runId);

    if (jsonMode) {
      const output = JSON.stringify(details, null, 2);
      return {
        subcommand: "status",
        args: subArgs,
        output,
        handled: true,
      };
    }

    const cardOutput = formatRunStatusCard(details, { width: 80 });

    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(cardOutput, "info");
    }

    return {
      subcommand: "status",
      args: subArgs,
      output: cardOutput,
      handled: true,
    };
  } catch (err: unknown) {
    const errorMsg = `Failed to get status for run '${runId}': ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(errorMsg, "error");
    }

    return {
      subcommand: "status",
      args: subArgs,
      output: errorMsg,
      handled: true,
    };
  }
}
