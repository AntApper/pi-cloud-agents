/**
 * Extension command handler for `/cloud diag <runId>` (T5.6).
 */

import { createDiagnosticsBundle } from "../../core/diagnostics-bundle.js";
import { resolveRunId } from "../../core/status.js";
import { PiPrompter } from "../prompter-pi.js";
import type { RouteContext, RouteResult } from "../router.js";
import { GLYPHS } from "../ui/kit.js";

export async function handleCloudDiagCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  let targetRunId = subArgs.find((a) => !a.startsWith("-"));

  if (!targetRunId) {
    if (ctx?.hasUI) {
      const prompter = new PiPrompter(ctx);
      targetRunId = await prompter.input("Enter run ID to export diagnostics bundle:");
    }
  }

  if (!targetRunId) {
    return {
      subcommand: "diag",
      args: subArgs,
      output: "Error: Run ID is required. Usage: /cloud diag <runId>",
      handled: true,
    };
  }

  try {
    const fullRunId = await resolveRunId(targetRunId);

    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(`Gathering diagnostics bundle for ${fullRunId}...`, "info");
    }

    const { bundle, bundleFilePath } = await createDiagnosticsBundle({
      runId: fullRunId,
    });

    const lines: string[] = [
      `${GLYPHS.pass} Diagnostics bundle created for ${fullRunId}.`,
      `File: ${bundleFilePath}`,
      `Log lines captured: ${bundle.logLines.length}`,
      `Manifest status: ${bundle.manifest?.status || "unknown"}`,
      "Secrets & Account IDs: Redacted",
    ];

    const output = lines.join("\n");
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(output, "info");
    }

    return {
      subcommand: "diag",
      args: subArgs,
      output,
      handled: true,
    };
  } catch (err: unknown) {
    const errorMsg = `Failed to create diagnostics bundle: ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(errorMsg, "error");
    }
    return {
      subcommand: "diag",
      args: subArgs,
      output: errorMsg,
      handled: true,
    };
  }
}
