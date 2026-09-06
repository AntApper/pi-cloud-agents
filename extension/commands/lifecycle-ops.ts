/**
 * Extension command handlers for `/cloud update` and `/cloud destroy` (T4.10).
 */

import { executeCloudDestroy, executeCloudUpdate } from "../../core/lifecycle-ops.js";
import { PiPrompter } from "../prompter-pi.js";
import type { RouteContext, RouteResult } from "../router.js";

/**
 * /cloud update [--dry-run] [--force]
 */
export async function handleCloudUpdateCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  const dryRun = subArgs.includes("--dry-run");
  const force = subArgs.includes("--force");

  try {
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify("Checking for runner image updates and configuration drift...", "info");
    }

    const result = await executeCloudUpdate({
      dryRun,
      force,
      onProgress: (_step, detail) => {
        if (ctx?.hasUI && ctx.ui?.notify) {
          ctx.ui.notify(`[update] ${detail}`, "info");
        }
      },
    });

    const lines: string[] = [];
    lines.push(`✓ ${result.message}`);
    if (result.newVersion) {
      lines.push(`Active image version: ${result.newVersion}`);
    }
    if (result.pruneResult?.prunedVersions.length) {
      lines.push(`Pruned older image versions: ${result.pruneResult.prunedVersions.join(", ")}`);
    }

    const output = lines.join("\n");
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(output, "info");
    }

    return {
      subcommand: "update",
      args: subArgs,
      output,
      handled: true,
    };
  } catch (err: unknown) {
    const errorMsg = `Cloud agent update failed: ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(errorMsg, "error");
    }
    return {
      subcommand: "update",
      args: subArgs,
      output: errorMsg,
      handled: true,
    };
  }
}

/**
 * /cloud destroy [--force] [--yes]
 */
export async function handleCloudDestroyCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  const force = subArgs.includes("--force") || subArgs.includes("-f");
  const skipConfirm = subArgs.includes("--yes") || subArgs.includes("-y") || force;

  try {
    if (!skipConfirm && ctx?.hasUI) {
      const prompter = new PiPrompter(ctx);
      const confirmWarning =
        "WARNING: This will permanently destroy all cloud agent infrastructure:\n" +
        "  - Terminate any running MicroVMs\n" +
        "  - Purge all objects in the S3 bucket\n" +
        "  - Force-delete Secrets Manager secrets\n" +
        "  - Delete image and core CloudFormation stacks\n" +
        "  - Remove local configuration";

      if (ctx.ui?.notify) {
        ctx.ui.notify(confirmWarning, "warning");
      }

      const confirmed = await prompter.confirm(
        "Are you absolutely sure you want to proceed with full destruction?",
        false,
      );

      if (!confirmed) {
        const cancelMsg = "Cloud agent teardown cancelled by user.";
        if (ctx.ui?.notify) ctx.ui.notify(cancelMsg, "info");
        return {
          subcommand: "destroy",
          args: subArgs,
          output: cancelMsg,
          handled: true,
        };
      }
    }

    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify("Starting teardown of all cloud agent infrastructure...", "info");
    }

    const result = await executeCloudDestroy({
      force: true,
      deleteLocalConfig: true,
      onProgress: (_step, detail) => {
        if (ctx?.hasUI && ctx.ui?.notify) {
          ctx.ui.notify(`[destroy] ${detail}`, "info");
        }
      },
    });

    const lines: string[] = [
      `✓ ${result.message}`,
      "",
      "Destroyed resources summary:",
      `  - Terminated MicroVMs: ${result.terminatedVmsCount}`,
      `  - Deleted Secrets:      ${result.deletedSecretsCount}`,
      `  - Deleted Stacks:       ${result.deletedStacks.join(", ") || "none"}`,
      `  - Purged S3 Bucket:     ${result.emptiedBucket || "none"}`,
      `  - Removed Local Config: ${result.removedLocalConfigFile ? "yes" : "no"}`,
      "",
      "Zero billable resources remain in your AWS account.",
    ];

    const output = lines.join("\n");
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(output, "info");
    }

    return {
      subcommand: "destroy",
      args: subArgs,
      output,
      handled: true,
    };
  } catch (err: unknown) {
    const errorMsg = `Cloud agent destroy failed: ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(errorMsg, "error");
    }
    return {
      subcommand: "destroy",
      args: subArgs,
      output: errorMsg,
      handled: true,
    };
  }
}
