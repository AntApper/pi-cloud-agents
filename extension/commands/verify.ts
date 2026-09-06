/**
 * Extension command handler for `/cloud verify [--with-model] [--no-model] [--json]`.
 */

import { formatVerifyReport, runVerification } from "../../core/verify/engine.js";
import type { RouteContext, RouteResult } from "../router.js";

export async function handleCloudVerifyCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  const jsonMode = subArgs.includes("--json");
  const withModel = subArgs.includes("--with-model") || !subArgs.includes("--no-model");

  try {
    const report = await runVerification({
      withModel,
      runSmoke: true,
      simulateSmoke: true,
    });

    const output = jsonMode ? JSON.stringify(report, null, 2) : formatVerifyReport(report);

    if (ctx?.hasUI && ctx.ui?.notify) {
      const notifyType =
        report.verdict === "PASS" ? "info" : report.verdict === "WARN" ? "warning" : "error";
      ctx.ui.notify(output, notifyType);
    }

    return {
      subcommand: "verify",
      args: subArgs,
      output,
      handled: true,
    };
  } catch (err: unknown) {
    const errorMsg = `Verification failed: ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(errorMsg, "error");
    }

    return {
      subcommand: "verify",
      args: subArgs,
      output: errorMsg,
      handled: true,
    };
  }
}
