/**
 * Extension command handler for `/cloud` (Hub / First-Run screen) (T4.15).
 */

import { isConfigured } from "../../core/config.js";
import { type RunListItem, listCloudRuns } from "../../core/list.js";
import type { RouteContext, RouteResult } from "../router.js";
import { GLYPHS } from "../ui/kit.js";

export function formatPreSetupHub(width = 80): string {
  const innerWidth = width - 4;
  const lines: string[] = [];
  const headerTitle = " pi cloud agents ";
  const topDashes = Math.max(0, width - 2 - headerTitle.length);

  lines.push(`┌${headerTitle}${"─".repeat(topDashes)}┐`);
  lines.push(
    `│ ${"Autonomous coding agents in isolated AWS Lambda MicroVMs".padEnd(innerWidth)} │`,
  );
  lines.push(`├${"─".repeat(width - 2)}┤`);
  lines.push(
    `│ ${"  1. Quick Setup: /cloud setup (or 'npx pi-cloud-agents setup')".padEnd(innerWidth)} │`,
  );
  lines.push(
    `│ ${"     - Deploys S3 storage, execution roles, and runner image".padEnd(innerWidth)} │`,
  );
  lines.push(
    `│ ${"     - Estimated idle cost: $0.00 / month (pay per second when running)".padEnd(innerWidth)} │`,
  );
  lines.push(`│ ${"     - Setup duration: ~15 minutes".padEnd(innerWidth)} │`);
  lines.push(`│ ${"".padEnd(innerWidth)} │`);
  lines.push(`│ ${"  2. Required Credentials:".padEnd(innerWidth)} │`);
  lines.push(
    `│ ${"     - AWS Profile with permissions (run '/cloud iam-policy' to view)".padEnd(innerWidth)} │`,
  );
  lines.push(`│ ${"".padEnd(innerWidth)} │`);
  lines.push(`│ ${"Run '/cloud setup' to begin.".padEnd(innerWidth)} │`);
  lines.push(`└${"─".repeat(width - 2)}┘`);

  return lines.join("\n");
}

export function formatPostSetupHub(
  runningCount: number,
  idleCount: number,
  totalRuns: number,
  width = 80,
): string {
  const innerWidth = width - 4;
  const lines: string[] = [];
  const headerTitle = " pi cloud agents · Hub ";
  const topDashes = Math.max(0, width - 2 - headerTitle.length);

  lines.push(`┌${headerTitle}${"─".repeat(topDashes)}┐`);
  lines.push(
    `│ ${`Fleet Status: ${GLYPHS.running} ${runningCount} running · ${GLYPHS.idle} ${idleCount} idle · ${totalRuns} total runs`.padEnd(innerWidth)} │`,
  );
  lines.push(`├${"─".repeat(width - 2)}┤`);
  lines.push(`│ ${"Quick Actions:".padEnd(innerWidth)} │`);
  lines.push(
    `│ ${"  /cloud new           - Launch a new autonomous cloud agent".padEnd(innerWidth)} │`,
  );
  lines.push(
    `│ ${"  /cloud list          - View active runs and select actions".padEnd(innerWidth)} │`,
  );
  lines.push(`│ ${"  /cloud dashboard     - Live fleet observability view".padEnd(innerWidth)} │`);
  lines.push(`│ ${"  /cloud verify        - Run health and smoke checks".padEnd(innerWidth)} │`);
  lines.push(
    `│ ${"  /cloud doctor        - Inspect system configuration & diagnostics".padEnd(innerWidth)} │`,
  );
  lines.push(
    `│ ${"  /cloud sync          - Refresh synced pi model credentials".padEnd(innerWidth)} │`,
  );
  lines.push(`└${"─".repeat(width - 2)}┘`);

  return lines.join("\n");
}

export async function handleCloudHubCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  const configured = isConfigured();

  if (!configured) {
    const output = formatPreSetupHub(80);
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(output, "info");
    }
    return {
      subcommand: "hub",
      args: subArgs,
      output,
      handled: true,
    };
  }

  let runningCount = 0;
  let idleCount = 0;
  let totalRuns = 0;
  try {
    const runs = await listCloudRuns();
    totalRuns = runs.length;
    runningCount = runs.filter((r: RunListItem) => r.status.toLowerCase() === "running").length;
    idleCount = runs.filter((r: RunListItem) => r.status.toLowerCase() === "idle").length;
  } catch {
    // Graceful fallback if list fetch fails
  }

  const output = formatPostSetupHub(runningCount, idleCount, totalRuns, 80);
  if (ctx?.hasUI && ctx.ui?.notify) {
    ctx.ui.notify(output, "info");
  }

  return {
    subcommand: "hub",
    args: subArgs,
    output,
    handled: true,
  };
}
