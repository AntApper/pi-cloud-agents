/**
 * Extension command handler for `/cloud new [prompt]`.
 */

import { type LaunchRunResult, launchCloudRun } from "../../core/launcher.js";
import type { RouteContext, RouteResult } from "../router.js";

export async function handleCloudNewCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  const promptText = subArgs.join(" ").trim();

  if (!promptText) {
    const errorMsg =
      "Usage: /cloud new <task prompt>\nExample: /cloud new Refactor the auth middleware to support bearer tokens";
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(errorMsg, "warning");
    }
    return {
      subcommand: "new",
      args: subArgs,
      output: errorMsg,
      handled: true,
    };
  }

  try {
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify("Launching cloud agent MicroVM...", "info");
    }

    const launchRes: LaunchRunResult = await launchCloudRun({
      prompt: promptText,
      onProgress: (_step, detail) => {
        if (ctx?.hasUI && ctx.ui?.notify && detail) {
          ctx.ui.notify(`[launch] ${detail}`, "info");
        }
      },
    });

    const outputLines = [
      "Cloud agent launched successfully.",
      `Run ID:      ${launchRes.runId}`,
      `MicroVM:     ${launchRes.microvmId}`,
      `Endpoint:    ${launchRes.endpoint}`,
      `Work Branch: ${launchRes.workBranch}`,
      "",
      "Next steps:",
      `  Attach mirror session: /cloud attach ${launchRes.runId}`,
      `  View status details:   /cloud status ${launchRes.runId}`,
    ];

    if (launchRes.warnings.length > 0) {
      outputLines.push("");
      outputLines.push("Warnings:");
      for (const w of launchRes.warnings) {
        outputLines.push(`  - ${w}`);
      }
    }

    const output = outputLines.join("\n");
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(output, "info");
    }

    return {
      subcommand: "new",
      args: subArgs,
      output,
      handled: true,
    };
  } catch (err: unknown) {
    const errorMsg = `Cloud launch failed: ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(errorMsg, "error");
    }

    return {
      subcommand: "new",
      args: subArgs,
      output: errorMsg,
      handled: true,
    };
  }
}
