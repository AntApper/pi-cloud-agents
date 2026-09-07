/**
 * Extension command handler for `/cloud dashboard` (T4.14).
 * Provides live fleet observability overlay in TUI mode and static view in RPC mode.
 */

import { fetchDashboardData, formatDashboardView } from "../../core/dashboard.js";
import type { RouteContext, RouteResult } from "../router.js";

export async function handleCloudDashboardCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  const jsonMode = subArgs.includes("--json");

  try {
    const data = await fetchDashboardData();

    if (jsonMode) {
      const output = JSON.stringify(data, null, 2);
      if (ctx?.hasUI && ctx.ui?.notify) {
        ctx.ui.notify(output, "info");
      }
      return {
        subcommand: "dashboard",
        args: subArgs,
        output,
        handled: true,
      };
    }

    const output = formatDashboardView(data, 80);

    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(output, "info");
    }

    return {
      subcommand: "dashboard",
      args: subArgs,
      output,
      handled: true,
    };
  } catch (err: unknown) {
    const errorMsg = `Failed to load dashboard: ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(errorMsg, "error");
    }
    return {
      subcommand: "dashboard",
      args: subArgs,
      output: errorMsg,
      handled: true,
    };
  }
}
