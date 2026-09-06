/**
 * Extension command handler for `/cloud config [key] [val]`.
 */

import {
  CONFIG_FIELDS,
  formatConfigView,
  getConfigValue,
  setConfigValue,
} from "../../core/config-editor.js";
import { loadLocalConfig, saveLocalConfig } from "../../core/config.js";
import type { RouteContext, RouteResult } from "../router.js";

export async function handleCloudConfigCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  const config = loadLocalConfig();

  // 1. View full configuration table: /cloud config
  if (subArgs.length === 0) {
    const tableText = formatConfigView(config);
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(tableText, "info");
    }
    return {
      subcommand: "config",
      args: subArgs,
      output: tableText,
      handled: true,
    };
  }

  const keyPath = subArgs[0]!;

  // 2. View specific key value: /cloud config <key>
  if (subArgs.length === 1) {
    const field = CONFIG_FIELDS.find((f) => f.key === keyPath);
    if (!field) {
      const errorMsg = `Unknown config key '${keyPath}'. Run '/cloud config' to see available keys.`;
      if (ctx?.hasUI && ctx.ui?.notify) {
        ctx.ui.notify(errorMsg, "error");
      }
      return {
        subcommand: "config",
        args: subArgs,
        output: errorMsg,
        handled: true,
      };
    }

    const val = getConfigValue(config, keyPath);
    const displayVal =
      val === undefined ? "(not set)" : Array.isArray(val) ? val.join(", ") : String(val);
    const output = `Config '${keyPath}': ${displayVal}\nDescription: ${field.description}`;

    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(output, "info");
    }
    return {
      subcommand: "config",
      args: subArgs,
      output,
      handled: true,
    };
  }

  // 3. Update key value: /cloud config <key> <val...>
  const rawValue = subArgs.slice(1).join(" ");
  try {
    const result = setConfigValue(config, keyPath, rawValue);
    saveLocalConfig(result.config);

    const prevDisplay =
      result.previousValue === undefined
        ? "(not set)"
        : Array.isArray(result.previousValue)
          ? result.previousValue.join(", ")
          : String(result.previousValue);
    const newDisplay =
      result.newValue === undefined
        ? "(not set)"
        : Array.isArray(result.newValue)
          ? result.newValue.join(", ")
          : String(result.newValue);

    const outputLines = [`Updated '${keyPath}' to: ${newDisplay} (was: ${prevDisplay})`];

    if (result.warnings.length > 0) {
      outputLines.push("");
      for (const warning of result.warnings) {
        outputLines.push(`Notice: ${warning}`);
      }
    }

    const output = outputLines.join("\n");
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(output, result.warnings.length > 0 ? "warning" : "info");
    }

    return {
      subcommand: "config",
      args: subArgs,
      output,
      handled: true,
    };
  } catch (err: unknown) {
    const errorMsg = `Failed to update '${keyPath}': ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(errorMsg, "error");
    }
    return {
      subcommand: "config",
      args: subArgs,
      output: errorMsg,
      handled: true,
    };
  }
}
