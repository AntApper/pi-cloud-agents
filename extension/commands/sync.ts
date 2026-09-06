/**
 * Extension command handler for `/cloud sync`.
 */

import { type SyncOptions, syncPiConfig } from "../../core/sync.js";
import type { RouteContext, RouteResult } from "../router.js";
import { bytes } from "../ui/kit.js";

export async function handleCloudSyncCommand(
  subArgs: string[],
  ctx?: RouteContext,
  syncOptions?: SyncOptions,
): Promise<RouteResult> {
  try {
    const result = await syncPiConfig(syncOptions);

    const width = 76;
    const lines: string[] = [];
    const title = " pi cloud agents · Sync Complete ";
    const topDashes = Math.max(0, width - 2 - title.length);

    lines.push(`┌${title}${"─".repeat(topDashes)}┐`);
    lines.push(`${`│ Synced at:    ${result.syncedAt}`.padEnd(width - 1)}│`);
    lines.push(`${`│ S3 Bucket:    ${result.bucketName}`.padEnd(width - 1)}│`);
    lines.push(`${`│ Bundle Key:   ${result.bundleKey}`.padEnd(width - 1)}│`);
    lines.push(`${`│ Bundle Size:  ${bytes(result.bundleBytes)}`.padEnd(width - 1)}│`);
    lines.push(`├${"─".repeat(width - 2)}┤`);

    const provStr =
      result.syncedProviders.length > 0
        ? result.syncedProviders.join(", ")
        : "(none - no local credentials selected)";
    lines.push(`${`│ Synced Providers: ${provStr}`.padEnd(width - 1)}│`);

    if (result.oauthProviders.length > 0) {
      lines.push(`${`│ OAuth Opt-ins:    ${result.oauthProviders.join(", ")}`.padEnd(width - 1)}│`);
    }

    if (result.warnings.length > 0) {
      lines.push(`├${"─".repeat(width - 2)}┤`);
      for (const warning of result.warnings) {
        lines.push(`${`│ Notice: ${warning}`.slice(0, width - 2).padEnd(width - 1)}│`);
      }
    }

    lines.push(`└${"─".repeat(width - 2)}┘`);
    const output = lines.join("\n");

    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(output, "info");
    }

    return {
      subcommand: "sync",
      args: subArgs,
      output,
      handled: true,
    };
  } catch (err: unknown) {
    const errorMsg = `Sync failed: ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(errorMsg, "error");
    }

    return {
      subcommand: "sync",
      args: subArgs,
      output: errorMsg,
      handled: true,
    };
  }
}
