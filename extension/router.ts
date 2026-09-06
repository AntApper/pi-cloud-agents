/**
 * Command router and completion engine for `/cloud <sub> [args]`.
 */

import { handleCloudConfigCommand } from "./commands/config.js";
import { type DoctorProbeOptions, formatDoctorTable, runDoctorDiagnostics } from "./doctor.js";

export interface SubcommandDefinition {
  name: string;
  description: string;
  usage: string;
  takesRunId?: boolean;
}

export const CLOUD_SUBCOMMANDS: SubcommandDefinition[] = [
  {
    name: "setup",
    description: "Set up cloud agents infrastructure and credentials",
    usage: "/cloud setup [--verify]",
  },
  {
    name: "verify",
    description: "Verify cloud agents infrastructure and run smoke test",
    usage: "/cloud verify [--with-model]",
  },
  {
    name: "doctor",
    description: "Inspect configuration and AWS environment health",
    usage: "/cloud doctor",
  },
  {
    name: "new",
    description: "Start a new cloud agent run on the current repository",
    usage: "/cloud new [prompt]",
  },
  { name: "list", description: "List active and recent cloud agent runs", usage: "/cloud list" },
  {
    name: "status",
    description: "Show detail card and live telemetry for a run",
    usage: "/cloud status <runId>",
    takesRunId: true,
  },
  {
    name: "attach",
    description: "Attach local mirror session to a cloud run",
    usage: "/cloud attach <runId>",
    takesRunId: true,
  },
  {
    name: "detach",
    description: "Detach current mirror session from cloud run",
    usage: "/cloud detach",
  },
  {
    name: "stop",
    description: "Terminate a running cloud agent VM",
    usage: "/cloud stop <runId>",
    takesRunId: true,
  },
  {
    name: "suspend",
    description: "Suspend a running cloud agent VM",
    usage: "/cloud suspend <runId>",
    takesRunId: true,
  },
  {
    name: "resume",
    description: "Resume a suspended cloud agent VM",
    usage: "/cloud resume <runId>",
    takesRunId: true,
  },
  {
    name: "logs",
    description: "View or tail CloudWatch logs for a run",
    usage: "/cloud logs <runId> [--follow]",
    takesRunId: true,
  },
  {
    name: "pr",
    description: "Create GitHub pull request from run work branch",
    usage: "/cloud pr <runId> [title]",
    takesRunId: true,
  },
  {
    name: "shell",
    description: "Open interactive shell inside cloud VM",
    usage: "/cloud shell <runId>",
    takesRunId: true,
  },
  {
    name: "config",
    description: "View and edit local cloud agent settings",
    usage: "/cloud config [key] [val]",
  },
  {
    name: "sync",
    description: "Refresh synced credentials and pi config bundle",
    usage: "/cloud sync",
  },
  {
    name: "dashboard",
    description: "Open live fleet observability dashboard",
    usage: "/cloud dashboard",
  },
  {
    name: "update",
    description: "Update runner image and CloudFormation stacks",
    usage: "/cloud update",
  },
  {
    name: "destroy",
    description: "Tear down all cloud agent infrastructure",
    usage: "/cloud destroy",
  },
  { name: "help", description: "Show cloud agent command catalog", usage: "/cloud help [sub]" },
];

export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

/**
 * Returns autocompletion suggestions for `/cloud ...` commands.
 */
export function getCloudArgumentCompletions(
  prefix: string,
  activeRunIds: string[] = [],
): AutocompleteItem[] | null {
  const trimmed = prefix.trimStart();
  const parts = trimmed.split(/\s+/);

  if (parts.length <= 1 && !prefix.endsWith(" ")) {
    // Autocomplete subcommand name
    const query = parts[0] || "";
    const matches = CLOUD_SUBCOMMANDS.filter((cmd) => cmd.name.startsWith(query));
    if (matches.length === 0) return null;
    return matches.map((cmd) => ({
      value: cmd.name,
      label: cmd.name,
      description: cmd.description,
    }));
  }

  const sub = parts[0]?.toLowerCase();
  const subDef = CLOUD_SUBCOMMANDS.find((cmd) => cmd.name === sub);

  if (subDef?.takesRunId) {
    const runArg = parts[1] || "";
    const matchingRuns = activeRunIds.filter((id) => id.startsWith(runArg));
    if (matchingRuns.length > 0) {
      return matchingRuns.map((id) => ({
        value: `${sub} ${id}`,
        label: id,
        description: `Active run ${id}`,
      }));
    }
  }

  return null;
}

/**
 * Formats the `/cloud help` command catalog table.
 */
export function formatHelpCatalog(): string {
  const width = 76;
  const innerWidth = width - 4;
  const lines: string[] = [];
  const headerTitle = " pi cloud agents · Command Catalog ";
  const topDashes = Math.max(0, width - 2 - headerTitle.length);

  lines.push(`┌${headerTitle}${"─".repeat(topDashes)}┐`);
  lines.push(`│ ${"Command".padEnd(20)} ${"Description".padEnd(innerWidth - 21)} │`);
  lines.push(`├${"─".repeat(width - 2)}┤`);

  for (const cmd of CLOUD_SUBCOMMANDS) {
    const namePart = `/cloud ${cmd.name}`.padEnd(20);
    const descPart = cmd.description.slice(0, innerWidth - 21);
    const line = `│ ${namePart} ${descPart.padEnd(innerWidth - 21)} │`;
    lines.push(line);
  }

  lines.push(`├${"─".repeat(width - 2)}┤`);
  lines.push(`│ ${"Usage: /cloud <command> [args]".padEnd(innerWidth)} │`);
  lines.push(
    `│ ${"For details, run: /cloud help <command> or /cloud doctor".padEnd(innerWidth)} │`,
  );
  lines.push(`└${"─".repeat(width - 2)}┘`);

  return lines.join("\n");
}

export interface RouteContext {
  hasUI?: boolean;
  mode?: "tui" | "rpc" | string;
  ui?: {
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
    setStatus?: (id: string, text: string) => void;
  };
}

export interface RouteResult {
  subcommand: string;
  args: string[];
  output: string;
  handled: boolean;
}

/**
 * Routes `/cloud <sub> [args]` command execution.
 */
export async function routeCloudCommand(
  rawArgs: string,
  ctx?: RouteContext,
  doctorOptions?: DoctorProbeOptions,
): Promise<RouteResult> {
  const trimmed = rawArgs.trim();
  const parts = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
  const sub = (parts[0] || "").toLowerCase();
  const subArgs = parts.slice(1);

  if (!sub || sub === "help") {
    const helpText = formatHelpCatalog();
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(helpText, "info");
    }
    return {
      subcommand: "help",
      args: subArgs,
      output: helpText,
      handled: true,
    };
  }

  if (sub === "doctor") {
    const report = await runDoctorDiagnostics(doctorOptions);
    const tableText = formatDoctorTable(report);
    if (ctx?.hasUI && ctx.ui?.notify) {
      const notifyType =
        report.verdict === "HEALTHY" ? "info" : report.verdict === "DEGRADED" ? "warning" : "error";
      ctx.ui.notify(tableText, notifyType);
    }
    return {
      subcommand: "doctor",
      args: subArgs,
      output: tableText,
      handled: true,
    };
  }

  if (sub === "config") {
    return handleCloudConfigCommand(subArgs, ctx);
  }

  const knownSub = CLOUD_SUBCOMMANDS.find((cmd) => cmd.name === sub);
  if (knownSub) {
    const notice = `Command '/cloud ${sub}' is stubbed in T4.1a and will be implemented in subsequent Phase 4 cards.\nUsage: ${knownSub.usage}\nRun '/cloud doctor' or '/cloud help'.`;
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(notice, "info");
    }
    return {
      subcommand: sub,
      args: subArgs,
      output: notice,
      handled: true,
    };
  }

  const unknownNotice = `Unknown cloud command: '/cloud ${sub}'. Run '/cloud help' to see available commands.`;
  if (ctx?.hasUI && ctx.ui?.notify) {
    ctx.ui.notify(unknownNotice, "error");
  }
  return {
    subcommand: sub,
    args: subArgs,
    output: unknownNotice,
    handled: false,
  };
}
