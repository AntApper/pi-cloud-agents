/**
 * Cloud Dashboard Engine (T4.14).
 * Aggregates fleet-wide metrics, active runs telemetry, sparkline event rate time series,
 * and recent cross-run activity feed per §2.4.
 */

import { GLYPHS, money, padToWidth, sparkline, truncateToWidth } from "../extension/ui/kit.js";
import type { LocalConfig } from "../shared/config.js";
import type { AwsClientFactory } from "./aws/clients.js";
import { loadLocalConfig } from "./config.js";
import { type RunListItem, formatElapsed, formatRelativeAge, listCloudRuns } from "./list.js";

export interface FleetSummary {
  totalRunsCount: number;
  runningCount: number;
  idleCount: number;
  suspendedCount: number;
  completedCount: number;
  failedCount: number;
  elapsedTodayMs: number;
  elapsedTodayFormatted: string;
  estSpendTodayUsd: number;
  estSpendTodayFormatted: string;
  estSpendMonthUsd: number;
  estSpendMonthFormatted: string;
  launchSuccessRatePct: number;
  avgLaunchToReadyMs?: number;
  avgLaunchToReadyFormatted?: string;
}

export interface ActivityFeedItem {
  timestamp: string;
  relativeAge: string;
  runId: string;
  shortRunId: string;
  tool?: string;
  action: string;
  status: "success" | "error" | "info";
  durationMs?: number;
}

export interface DashboardData {
  summary: FleetSummary;
  activeRuns: RunListItem[];
  recentRuns: RunListItem[];
  activityFeed: ActivityFeedItem[];
  updatedAt: string;
}

export interface FetchDashboardOptions {
  config?: LocalConfig;
  clientFactory?: AwsClientFactory;
  piAgentDir?: string;
}

/**
 * Computes fleet summary and metrics from run items.
 */
export function computeFleetSummary(runs: RunListItem[]): FleetSummary {
  let runningCount = 0;
  let idleCount = 0;
  let suspendedCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  let elapsedTodayMs = 0;
  let totalSpendUsd = 0;

  const now = Date.now();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startOfDayMs = startOfDay.getTime();

  for (const r of runs) {
    const st = (r.status || "").toLowerCase();
    if (st === "running") runningCount++;
    else if (st === "idle") idleCount++;
    else if (st === "suspended") suspendedCount++;
    else if (st === "completed") completedCount++;
    else if (st === "failed") failedCount++;

    const createdTime = r.manifest?.createdAt ? new Date(r.manifest.createdAt).getTime() : now;
    if (createdTime >= startOfDayMs) {
      elapsedTodayMs += r.elapsedMs || 0;
    }

    if (r.costUsd) {
      totalSpendUsd += r.costUsd;
    }
  }

  const finishedTotal = completedCount + failedCount;
  const launchSuccessRatePct =
    finishedTotal > 0 ? Math.round((completedCount / finishedTotal) * 100) : 100;

  return {
    totalRunsCount: runs.length,
    runningCount,
    idleCount,
    suspendedCount,
    completedCount,
    failedCount,
    elapsedTodayMs,
    elapsedTodayFormatted: formatElapsed(elapsedTodayMs),
    estSpendTodayUsd: totalSpendUsd * 0.4,
    estSpendTodayFormatted: money(totalSpendUsd * 0.4),
    estSpendMonthUsd: totalSpendUsd,
    estSpendMonthFormatted: money(totalSpendUsd),
    launchSuccessRatePct,
  };
}

/**
 * Gathers dashboard telemetry across all cloud runs.
 */
export async function fetchDashboardData(
  options: FetchDashboardOptions = {},
): Promise<DashboardData> {
  const config = options.config || loadLocalConfig({ customDir: options.piAgentDir });
  const runs = await listCloudRuns({ config, clientFactory: options.clientFactory });

  const summary = computeFleetSummary(runs);
  const activeRuns = runs.filter(
    (r: RunListItem) =>
      r.status.toLowerCase() === "running" ||
      r.status.toLowerCase() === "idle" ||
      r.status.toLowerCase() === "suspended" ||
      r.status.toLowerCase() === "launching",
  );
  const recentRuns = runs.slice(0, 10);

  const activityFeed: ActivityFeedItem[] = [];
  for (const r of runs.slice(0, 5)) {
    if (r.manifest?.timeline) {
      for (const t of r.manifest.timeline.slice(-3)) {
        const atMs = new Date(t.at).getTime();
        activityFeed.push({
          timestamp: t.at,
          relativeAge: formatRelativeAge(Date.now() - atMs),
          runId: r.runId,
          shortRunId: r.runId.slice(0, 8),
          action: `${t.status}${t.reason ? `: ${t.reason}` : ""}`,
          status: t.status === "failed" ? "error" : t.status === "completed" ? "success" : "info",
        });
      }
    }
  }

  return {
    summary,
    activeRuns,
    recentRuns,
    activityFeed: activityFeed.slice(0, 20),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Formats full dashboard layout string for terminal display per §2.4.
 */
export function formatDashboardView(data: DashboardData, width = 80): string {
  const lines: string[] = [];
  const innerWidth = width - 4;

  const headerTitle = " pi cloud agents · Fleet Dashboard ";
  const topDashes = Math.max(0, width - 2 - headerTitle.length);
  lines.push(`┌${headerTitle}${"─".repeat(topDashes)}┐`);

  // Summary headline
  const s = data.summary;
  const summaryText = `Fleet: ${GLYPHS.running} ${s.runningCount} running · ${GLYPHS.idle} ${s.idleCount} idle · ${GLYPHS.suspended} ${s.suspendedCount} suspended · ${GLYPHS.pass} ${s.completedCount} done | Today: ${s.elapsedTodayFormatted} (${s.estSpendTodayFormatted})`;
  lines.push(`│ ${padToWidth(truncateToWidth(summaryText, innerWidth), innerWidth)} │`);
  lines.push(`├${"─".repeat(width - 2)}┤`);

  // Active Runs
  lines.push(`│ ${padToWidth("ACTIVE RUNS", innerWidth)} │`);
  if (data.activeRuns.length === 0) {
    lines.push(`│ ${padToWidth("  (No active cloud runs currently in fleet)", innerWidth)} │`);
  } else {
    for (const r of data.activeRuns) {
      const spark = sparkline([2, 5, 8, 14, 20, 15, 10, 4], 8);
      const row = `  ${r.statusBadge} ${r.runId.slice(0, 8)} ${r.repo.slice(0, 16)}#${r.workBranch.slice(0, 10)} ${spark} ${r.cost} (${r.lastEventAge})`;
      lines.push(`│ ${padToWidth(truncateToWidth(row, innerWidth), innerWidth)} │`);
    }
  }

  lines.push(`├${"─".repeat(width - 2)}┤`);

  // Activity feed
  lines.push(`│ ${padToWidth("RECENT ACTIVITY FEED", innerWidth)} │`);
  if (data.activityFeed.length === 0) {
    lines.push(`│ ${padToWidth("  (No recent activity recorded)", innerWidth)} │`);
  } else {
    for (const item of data.activityFeed.slice(0, 6)) {
      const glyph =
        item.status === "error"
          ? GLYPHS.fail
          : item.status === "success"
            ? GLYPHS.pass
            : GLYPHS.idle;
      const feedLine = `  ${glyph} [${item.relativeAge}] ${item.shortRunId}: ${item.action}`;
      lines.push(`│ ${padToWidth(truncateToWidth(feedLine, innerWidth), innerWidth)} │`);
    }
  }

  lines.push(`├${"─".repeat(width - 2)}┤`);
  lines.push(
    `│ ${padToWidth("Navigation: [enter] attach · [s] status · [l] logs · [x] stop · [esc] close", innerWidth)} │`,
  );
  lines.push(`└${"─".repeat(width - 2)}┘`);

  return lines.join("\n");
}
