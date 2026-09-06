/**
 * Extension command handler for `/cloud setup [--verify] [--dry-run]`.
 */

import { executeSetup } from "../../core/setup/run.js";
import { type SetupWizardOptions, runSetupWizard } from "../../core/setup/steps.js";
import { PiPrompter } from "../prompter-pi.js";
import type { RouteContext, RouteResult } from "../router.js";

export async function handleCloudSetupCommand(
  subArgs: string[],
  ctx?: RouteContext,
  customOptions?: Partial<SetupWizardOptions>,
): Promise<RouteResult> {
  const dryRun = subArgs.includes("--dry-run") || Boolean(customOptions?.dryRun);
  const verifyAfter = subArgs.includes("--verify");
  const prompter = new PiPrompter(ctx);

  try {
    const wizardResult = await runSetupWizard({
      prompter,
      dryRun,
      ...customOptions,
    });

    if (wizardResult.cancelled) {
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

    if (wizardResult.dryRun) {
      const outputLines = [
        wizardResult.planText,
        "",
        "Plan preview generated (dry-run). No infrastructure or configuration was modified.",
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
    }

    // Execute actual deployment and setup workflow
    const execRes = await executeSetup({
      config: wizardResult.config,
      prompter,
      clientFactory: customOptions?.clientFactory,
      githubToken: wizardResult.githubToken,
      piAgentDir: customOptions?.piAgentDir,
      authEntries: customOptions?.authEntries,
    });

    if (!execRes.success) {
      const errMsg = execRes.error?.message || "Setup execution encountered an error.";
      if (ctx?.hasUI && ctx.ui?.notify) {
        ctx.ui.notify(errMsg, "error");
      }
      return {
        subcommand: "setup",
        args: subArgs,
        output: errMsg,
        handled: true,
      };
    }

    const outputLines = [
      wizardResult.planText,
      "",
      `Setup completed successfully in region ${execRes.region}.`,
      `Core Stack: ${execRes.stackName}`,
      execRes.imageArn ? `Runner Image: ${execRes.imageArn}` : "",
      execRes.bucketName ? `S3 Storage Bucket: ${execRes.bucketName}` : "",
      "",
      verifyAfter
        ? "Next: Running verification engine..."
        : "Ready: Launch your first cloud agent with '/cloud new' or verify with '/cloud verify'.",
    ].filter(Boolean);

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
