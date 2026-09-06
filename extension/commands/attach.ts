/**
 * Extension command handlers for `/cloud attach` and `/cloud detach` (T4.7a).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listCloudRuns } from "../../core/list.js";
import { PiPrompter } from "../prompter-pi.js";
import type { RouteContext, RouteResult } from "../router.js";
import {
  createAndAttachMirrorSession,
  detachActiveMirrorSession,
  getActiveMirrorSession,
} from "../ui/mirror.js";

/**
 * Helper to resolve runId from args or interactive prompt.
 */
async function getOrPromptRunId(
  subArgs: string[],
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
        runId = await prompter.select("Select a cloud run to attach mirror session:", options);
      }
    } catch {
      // Fall through
    }
  }

  return runId;
}

/**
 * /cloud attach <runId>
 */
export async function handleCloudAttachCommand(
  subArgs: string[],
  ctx?: RouteContext,
  pi?: ExtensionAPI | null,
): Promise<RouteResult> {
  const runId = await getOrPromptRunId(subArgs, ctx);

  if (!runId) {
    const usageMsg = "Usage: /cloud attach <runId>\nExample: /cloud attach 7f3a2c";
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(usageMsg, "warning");
    }
    return { subcommand: "attach", args: subArgs, output: usageMsg, handled: true };
  }

  try {
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(`Attaching mirror session to cloud run '${runId}'...`, "info");
    }

    const session = await createAndAttachMirrorSession({
      runId,
      ctx: ctx || {},
      pi,
    });

    const output = `✓ Attached mirror session to cloud run '${session.shortRunId}' (${session.metadata.status || "running"}).`;
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(output, "info");
    }

    return { subcommand: "attach", args: subArgs, output, handled: true };
  } catch (err: unknown) {
    const errorMsg = `Failed to attach mirror session to run '${runId}': ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(errorMsg, "error");
    }
    return { subcommand: "attach", args: subArgs, output: errorMsg, handled: true };
  }
}

/**
 * /cloud detach
 */
export async function handleCloudDetachCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  const activeSession = getActiveMirrorSession();

  if (!activeSession) {
    const notice = "No cloud mirror session currently attached.";
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(notice, "info");
    }
    return { subcommand: "detach", args: subArgs, output: notice, handled: true };
  }

  const runId = activeSession.shortRunId;
  detachActiveMirrorSession();

  const output = `✓ Detached mirror session from cloud run '${runId}'.`;
  if (ctx?.hasUI && ctx.ui?.notify) {
    ctx.ui.notify(output, "info");
  }

  return { subcommand: "detach", args: subArgs, output, handled: true };
}
