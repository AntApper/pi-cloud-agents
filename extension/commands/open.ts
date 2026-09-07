/**
 * Extension command handler for `/cloud open <runId>` (T4.12).
 * Downloads remote session transcript, saves to local sessions directory,
 * and switches into read-only viewer mode.
 */

import { importRemoteSession } from "../../core/session-importer.js";
import { resolveRunId } from "../../core/status.js";
import { PiPrompter } from "../prompter-pi.js";
import type { RouteContext, RouteResult } from "../router.js";
import { GLYPHS } from "../ui/kit.js";

export async function handleCloudOpenCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  let targetRunId = subArgs.find((a) => !a.startsWith("-"));

  if (!targetRunId) {
    if (ctx?.hasUI) {
      const prompter = new PiPrompter(ctx);
      targetRunId = await prompter.input("Enter run ID to open transcript:");
    }
  }

  if (!targetRunId) {
    return {
      subcommand: "open",
      args: subArgs,
      output: "Error: Run ID is required. Usage: /cloud open <runId>",
      handled: true,
    };
  }

  try {
    const fullRunId = await resolveRunId(targetRunId);

    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(`Downloading session transcript for ${fullRunId}...`, "info");
    }

    const result = await importRemoteSession({
      runId: fullRunId,
      targetDir: (ctx as unknown as { cwd?: string })?.cwd || process.cwd(),
    });

    const lines: string[] = [
      `${GLYPHS.pass} Session transcript for ${fullRunId} downloaded successfully.`,
      `Entries: ${result.entryCount} · File: ${result.sessionFilePath}`,
      `Mode: Read-only viewer (typing disabled in viewer mode; use /cloud attach ${fullRunId} to interact)`,
    ];

    // If ctx has switchSession API, switch to the imported session
    const untypedCtx = ctx as unknown as { switchSession?: (path: string) => Promise<void> };
    if (typeof untypedCtx?.switchSession === "function") {
      await untypedCtx.switchSession(result.sessionFilePath);
    }

    const output = lines.join("\n");
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(output, "info");
    }

    return {
      subcommand: "open",
      args: subArgs,
      output,
      handled: true,
    };
  } catch (err: unknown) {
    const errorMsg = `Failed to open cloud session: ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(errorMsg, "error");
    }
    return {
      subcommand: "open",
      args: subArgs,
      output: errorMsg,
      handled: true,
    };
  }
}
