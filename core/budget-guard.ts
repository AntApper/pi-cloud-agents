/**
 * Cost and Budget Guard Engine (T5.4).
 * Enforces maximum duration bounds (<= 8h), concurrency limits, and month-to-date budget thresholds.
 */

import type { LocalConfig } from "../shared/config.js";
import type { AwsClientFactory } from "./aws/clients.js";
import { loadLocalConfig } from "./config.js";
import { type RunListItem, listCloudRuns } from "./list.js";

export interface BudgetGuardStatus {
  maxDurationHours: number;
  maxConcurrent: number;
  activeRunsCount: number;
  availableConcurrency: number;
  canLaunch: boolean;
  mtdSpendUsd: number;
  budgetMonthlyUsd?: number;
  budgetExceeded: boolean;
  warningMessage?: string;
}

export interface CheckBudgetOptions {
  config?: LocalConfig;
  clientFactory?: AwsClientFactory;
  piAgentDir?: string;
  monthlyBudgetUsd?: number;
}

/**
 * Validates requested max duration hours against AWS Lambda MicroVM 8-hour hard limit.
 */
export function validateMaxDurationHours(hours: number): {
  valid: boolean;
  normalizedHours: number;
} {
  if (hours <= 0) {
    return { valid: false, normalizedHours: 4 };
  }
  if (hours > 8) {
    return { valid: false, normalizedHours: 8 };
  }
  return { valid: true, normalizedHours: hours };
}

/**
 * Computes month-to-date (MTD) estimated spend across all cloud agent runs.
 */
export function calculateMtdSpend(runs: RunListItem[]): number {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  let totalUsd = 0;
  for (const r of runs) {
    const createdAt = r.manifest?.createdAt ? new Date(r.manifest.createdAt).getTime() : 0;
    if (createdAt >= startOfMonth && r.costUsd) {
      totalUsd += r.costUsd;
    }
  }

  return Math.round(totalUsd * 100) / 100;
}

/**
 * Evaluates current budget and concurrency status before launching new runs.
 */
export async function evaluateBudgetGuard(
  options: CheckBudgetOptions = {},
): Promise<BudgetGuardStatus> {
  const config = options.config || loadLocalConfig({ customDir: options.piAgentDir });
  const maxDurationHours = config.defaults.maxDurationHours || 4;
  const maxConcurrent = config.defaults.maxConcurrent || 3;

  const runs = await listCloudRuns({ config, clientFactory: options.clientFactory });

  const activeRuns = runs.filter(
    (r: RunListItem) =>
      r.status.toLowerCase() === "running" ||
      r.status.toLowerCase() === "idle" ||
      r.status.toLowerCase() === "suspended" ||
      r.status.toLowerCase() === "launching",
  );

  const activeRunsCount = activeRuns.length;
  const availableConcurrency = Math.max(0, maxConcurrent - activeRunsCount);
  const canLaunch = availableConcurrency > 0;

  const mtdSpendUsd = calculateMtdSpend(runs);
  const budgetMonthlyUsd = options.monthlyBudgetUsd;
  const budgetExceeded = budgetMonthlyUsd !== undefined && mtdSpendUsd > budgetMonthlyUsd;

  let warningMessage: string | undefined;
  if (!canLaunch) {
    warningMessage = `Concurrency limit reached (${activeRunsCount}/${maxConcurrent} active runs). Terminate or wait for an active run to complete before launching.`;
  } else if (budgetExceeded) {
    warningMessage = `Month-to-date estimated cloud spend ($${mtdSpendUsd.toFixed(2)}) exceeds configured monthly budget threshold ($${budgetMonthlyUsd?.toFixed(2)}).`;
  }

  return {
    maxDurationHours,
    maxConcurrent,
    activeRunsCount,
    availableConcurrency,
    canLaunch,
    mtdSpendUsd,
    budgetMonthlyUsd,
    budgetExceeded,
    warningMessage,
  };
}
