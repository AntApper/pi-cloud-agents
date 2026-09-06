/**
 * Extension command handler for `/cloud setup [--verify] [--dry-run]`.
 */

import { type SetupWizardOptions, runSetupWizard } from "../../core/setup/steps.js";
import { PiPrompter } from "../prompter-pi.js";
import type { RouteContext, RouteResult } from "../router.js";

export async function handleCloudSetupCommand(
  subArgs: string[],
  ctx?: RouteContext,
  customOptions?: Partial<SetupWizardOptions>,
): Promise<RouteResult> {
  const dryRun = subArgs.includes("--dry-run") || Boolean(customOptions?.dryRun);
  const prompter = new PiPrompter(ctx);

  try {
    const result = await runSetupWizard({
      prompter,
      dryRun,
      ...customOptions,
    });

    if (result.cancelled) {
      const cancelMsg = "Setup cancelled by user.";
      if (ctx?.hasUI && ctx.ui?.notify) {
        ctx.ui.notify(cancelMsg, "warning");
      }
      return {
        subcommand: "setup",
        args: subArgs,
        output: cancelMsg,
        handled: true,
      };
    }

    const outputLines = [
      result.planText,
      "",
      result.dryRun
        ? "Plan preview generated (dry-run). No configuration was saved."
        : "Configuration saved to ~/.pi/agent/pi-cloud-agents.json. Next: run '/cloud verify' to test infrastructure.",
    ];

    const output = outputLines.join("\n");
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(output, "info");
    }

    return {
      subcommand: "setup",
      args: subArgs,
      output,
      handled: true,
    };
  } catch (err: unknown) {
    const errorMsg = `Setup failed: ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(errorMsg, "error");
    }

    return {
      subcommand: "setup",
      args: subArgs,
      output: errorMsg,
      handled: true,
    };
  }
}
