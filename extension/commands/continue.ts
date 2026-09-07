/**
 * Extension command handler for `/cloud continue <runId>` (T5.3).
 */

import { continueCloudRun } from "../../core/continuation.js";
import { resolveRunId } from "../../core/status.js";
import { PiPrompter } from "../prompter-pi.js";
import type { RouteContext, RouteResult } from "../router.js";
import { GLYPHS } from "../ui/kit.js";

export async function handleCloudContinueCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  let targetRunId = subArgs.find((a) => !a.startsWith("-"));

  if (!targetRunId) {
    if (ctx?.hasUI) {
      const prompter = new PiPrompter(ctx);
      targetRunId = await prompter.input("Enter prior run ID to continue from:");
    }
  }

  if (!targetRunId) {
    return {
      subcommand: "continue",
      args: subArgs,
      output: "Error: Run ID is required. Usage: /cloud continue <runId>",
      handled: true,
    };
  }

  try {
    const fullRunId = await resolveRunId(targetRunId);

    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(`Continuing run from ${fullRunId}...`, "info");
    }

    const result = await continueCloudRun({
      priorRunId: fullRunId,
      repoDir: (ctx as unknown as { cwd?: string })?.cwd || process.cwd(),
      onProgress: (_step, detail) => {
        if (ctx?.hasUI && ctx.ui?.notify && detail) {
          ctx.ui.notify(detail, "info");
        }
      },
    });

    const lines: string[] = [
      `${GLYPHS.pass} Cloud run continued in new MicroVM.`,
      `New Run ID: ${result.newRunId}`,
      `Continued from: ${result.priorRunId}`,
      `Work Branch: ${result.workBranch}`,
      `Attach to live session: /cloud attach ${result.newRunId}`,
    ];

    const output = lines.join("\n");
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(output, "info");
    }

    return {
      subcommand: "continue",
      args: subArgs,
      output,
      handled: true,
    };
  } catch (err: unknown) {
    const errorMsg = `Failed to continue cloud run: ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(errorMsg, "error");
    }
    return {
      subcommand: "continue",
      args: subArgs,
      output: errorMsg,
      handled: true,
    };
  }
}
