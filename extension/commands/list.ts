/**
 * Extension command handler for `/cloud list`.
 * Formats width-safe run table per 07-ux-and-observability.md §2.2
 * and provides interactive action menu (attach · status · dashboard · logs · pr · stop).
 */

import { type RunListItem, listCloudRuns } from "../../core/list.js";
import { PiPrompter } from "../prompter-pi.js";
import type { RouteContext, RouteResult } from "../router.js";
import { type TableColumn, table } from "../ui/kit.js";

/**
 * Formats run items into a responsive, aligned Unicode table.
 */
export function formatRunsTable(runs: RunListItem[], options: { maxWidth?: number } = {}): string {
  if (runs.length === 0) {
    return "No cloud agent runs found. Start a run with '/cloud new <prompt>'.";
  }

  const maxWidth = options.maxWidth ?? 80;

  // Responsive column set: compact at 80 cols, full at 120 cols
  const cols: TableColumn<RunListItem>[] =
    maxWidth >= 100
      ? [
          { key: "statusBadge", label: "State", minWidth: 8, width: 11 },
          { key: "runId", label: "Run", minWidth: 6, width: 8 },
          { key: "repo", label: "Repository#Branch", minWidth: 14, width: 22 },
          { key: "model", label: "Model", minWidth: 8, width: 14 },
          { key: "activity", label: "Activity", minWidth: 8, width: 14 },
          { key: "turns", label: "Turns", minWidth: 4, width: 5, align: "right" },
          { key: "tokens", label: "Tokens", minWidth: 5, width: 7, align: "right" },
          { key: "cost", label: "Cost", minWidth: 7, width: 10, align: "right" },
          { key: "elapsed", label: "Elapsed", minWidth: 5, width: 7, align: "right" },
          { key: "lastEventAge", label: "Last Event", minWidth: 7, width: 10, align: "right" },
        ]
      : [
          { key: "statusBadge", label: "State", minWidth: 8, width: 11 },
          { key: "runId", label: "Run", minWidth: 6, width: 8 },
          { key: "repo", label: "Repository#Branch", minWidth: 12, width: 16 },
          { key: "activity", label: "Activity", minWidth: 8, width: 11 },
          { key: "turns", label: "Turns", minWidth: 4, width: 5, align: "right" },
          { key: "cost", label: "Cost", minWidth: 7, width: 9, align: "right" },
          { key: "elapsed", label: "Elapsed", minWidth: 5, width: 7, align: "right" },
        ];

  return table({
    cols,
    rows: runs,
    maxWidth,
    bordered: true,
  });
}

export async function handleCloudListCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  const jsonMode = subArgs.includes("--json");

  try {
    const runs = await listCloudRuns();

    if (jsonMode) {
      const output = JSON.stringify(runs, null, 2);
      return {
        subcommand: "list",
        args: subArgs,
        output,
        handled: true,
      };
    }

    const tableOutput = formatRunsTable(runs, { maxWidth: 80 });

    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(tableOutput, "info");
    }

    // Interactive action menu if UI selection is supported and runs exist
    if (ctx?.hasUI && runs.length > 0 && !subArgs.includes("--non-interactive")) {
      try {
        const prompter = new PiPrompter(ctx);
        const runOptions = runs.map((r) => ({
          label: `${r.statusBadge}  ${r.runId}  ${r.repo}  ${r.cost}`,
          value: r.fullRunId,
        }));

        const selectedRunId = await prompter.select("Select a cloud run:", runOptions);
        if (selectedRunId) {
          const actionOptions = [
            { label: "Attach mirror session", value: `attach ${selectedRunId}` },
            { label: "View status detail card", value: `status ${selectedRunId}` },
            { label: "Open live dashboard", value: "dashboard" },
            { label: "View CloudWatch logs", value: `logs ${selectedRunId}` },
            { label: "Create GitHub pull request", value: `pr ${selectedRunId}` },
            { label: "Stop MicroVM", value: `stop ${selectedRunId}` },
          ];

          const action = await prompter.select(
            `Actions for run '${selectedRunId}':`,
            actionOptions,
          );
          if (action) {
            // Dynamic import router to avoid circular dependency
            const { routeCloudCommand } = await import("../router.js");
            return routeCloudCommand(action, ctx);
          }
        }
      } catch {
        // Fall back to table output if menu was cancelled or unsupported
      }
    }

    return {
      subcommand: "list",
      args: subArgs,
      output: tableOutput,
      handled: true,
    };
  } catch (err: unknown) {
    const errorMsg = `Failed to list cloud runs: ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(errorMsg, "error");
    }

    return {
      subcommand: "list",
      args: subArgs,
      output: errorMsg,
      handled: true,
    };
  }
}
