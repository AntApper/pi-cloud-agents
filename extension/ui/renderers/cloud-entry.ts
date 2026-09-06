/**
 * Cloud Mirror Entry Formatter & Renderers (T4.7c).
 * Formats remote messages, thinking blocks, bash tool outputs, edit diffs,
 * file tool operations, error notices, and compaction events.
 */

import { GLYPHS, box, truncateToWidth } from "../kit.js";
import type { CloudMessageEntry } from "../mirror.js";

export interface EntryRenderSettings {
  width?: number;
  expanded?: boolean;
  showThinking?: boolean;
  maxOutputLines?: number;
}

export const DEFAULT_MAX_OUTPUT_LINES = 10;

/**
 * Formats a CloudMessageEntry into width-safe terminal text.
 */
export function formatCloudMessage(
  entry: CloudMessageEntry,
  options: EntryRenderSettings = {},
): string {
  const width = options.width ?? 80;
  const expanded = options.expanded ?? false;
  const showThinking = options.showThinking ?? true;
  const maxLines = options.maxOutputLines ?? DEFAULT_MAX_OUTPUT_LINES;

  const lines: string[] = [];

  // 1. Assistant messages
  if (entry.role === "assistant") {
    // Thinking block
    if (entry.thinking && showThinking) {
      lines.push(`${GLYPHS.middleDot} thinking:`);
      const thinkLines = entry.thinking.split("\n");
      const displayedThinkLines = expanded ? thinkLines : thinkLines.slice(0, 4);
      for (const tLine of displayedThinkLines) {
        lines.push(`  ${truncateToWidth(tLine, width - 4)}`);
      }
      if (!expanded && thinkLines.length > 4) {
        lines.push(`  ${GLYPHS.ellipsis} (${thinkLines.length - 4} more thinking lines)`);
      }
      lines.push("");
    }

    const contentStr =
      typeof entry.content === "string"
        ? entry.content
        : Array.isArray(entry.content)
          ? entry.content.map((c) => (c.text ? String(c.text) : JSON.stringify(c))).join("\n")
          : String(entry.content || "");

    const msgLines = contentStr.split("\n");
    for (const mLine of msgLines) {
      lines.push(truncateToWidth(mLine, width));
    }

    return lines.join("\n");
  }

  // 2. User messages
  if (entry.role === "user") {
    const contentStr =
      typeof entry.content === "string" ? entry.content : String(entry.content || "");
    const msgLines = contentStr.split("\n");
    for (let i = 0; i < msgLines.length; i++) {
      const prefix = i === 0 ? "> " : "  ";
      lines.push(truncateToWidth(`${prefix}${msgLines[i]}`, width));
    }
    return lines.join("\n");
  }

  // 3. Tool results & calls
  if (entry.role === "tool" || entry.toolName) {
    const toolName = (entry.toolName || "tool").toLowerCase();
    const toolArgs = entry.toolArgs || {};
    const details = entry.details || {};

    switch (toolName) {
      case "bash": {
        const cmd =
          (details.command as string) ||
          (toolArgs.command as string) ||
          (entry.content && typeof entry.content === "string" && entry.content.startsWith("$")
            ? entry.content.slice(1).trim()
            : "bash command");

        const exitCode = details.exitCode !== undefined ? details.exitCode : entry.isError ? 1 : 0;
        const statusGlyph = exitCode === 0 ? GLYPHS.pass : GLYPHS.fail;
        const durStr = details.durationMs
          ? ` (${Math.round(details.durationMs as number)} ms)`
          : "";

        lines.push(`${statusGlyph} bash: $ ${cmd}${durStr}`);

        const outputStr =
          typeof entry.content === "string"
            ? entry.content
            : entry.toolResult
              ? String(entry.toolResult)
              : "";

        if (outputStr.trim().length > 0) {
          const outLines = outputStr.split("\n");
          let displayedLines = outLines;
          let truncatedNotice = "";

          if (!expanded && outLines.length > maxLines) {
            displayedLines = outLines.slice(0, maxLines);
            truncatedNotice = `${GLYPHS.ellipsis} (${outLines.length - maxLines} lines hidden)`;
          }

          const boxed = box(displayedLines, { width, footer: truncatedNotice || undefined });
          lines.push(boxed);
        }
        break;
      }

      case "edit": {
        const filePath =
          (details.filePath as string) ||
          (toolArgs.path as string) ||
          (toolArgs.filePath as string) ||
          "file";
        const diffStr = (details.diff as string) || (entry.content as string) || "";

        lines.push(`${GLYPHS.pass} edit: ${filePath}`);

        if (diffStr.trim().length > 0) {
          const diffLines = diffStr.split("\n");
          let displayedDiff = diffLines;
          let footerNotice = "";

          if (!expanded && diffLines.length > maxLines + 5) {
            displayedDiff = diffLines.slice(0, maxLines + 5);
            footerNotice = `${GLYPHS.ellipsis} (${diffLines.length - (maxLines + 5)} diff lines)`;
          }

          const formattedDiffLines = displayedDiff.map((line) => {
            if (line.startsWith("+")) {
              return `+ ${line.slice(1)}`;
            }
            if (line.startsWith("-")) {
              return `- ${line.slice(1)}`;
            }
            return `  ${line}`;
          });

          const boxed = box(formattedDiffLines, {
            width,
            title: `diff ${filePath}`,
            footer: footerNotice || undefined,
          });
          lines.push(boxed);
        }
        break;
      }

      case "read": {
        const filePath =
          (details.filePath as string) ||
          (toolArgs.path as string) ||
          (toolArgs.filePath as string) ||
          "file";
        const lineCount = details.lines ?? details.lineCount;
        const lineCountStr = lineCount !== undefined ? ` (${lineCount} lines)` : "";
        lines.push(`${GLYPHS.pass} read: ${filePath}${lineCountStr}`);
        break;
      }

      case "write": {
        const filePath =
          (details.filePath as string) ||
          (toolArgs.path as string) ||
          (toolArgs.filePath as string) ||
          "file";
        const byteCount = details.bytes ?? details.byteCount;
        const byteCountStr = byteCount !== undefined ? ` (${byteCount} bytes)` : "";
        lines.push(`${GLYPHS.pass} write: ${filePath}${byteCountStr}`);
        break;
      }

      case "grep": {
        const pattern = (toolArgs.pattern as string) || (details.pattern as string) || "";
        const targetPath = (toolArgs.path as string) || (details.path as string) || ".";
        const matchCount = details.matches ?? details.matchCount;
        const matchStr = matchCount !== undefined ? ` (${matchCount} matches)` : "";
        lines.push(`${GLYPHS.pass} grep: "${pattern}" in ${targetPath}${matchStr}`);
        break;
      }

      case "find": {
        const pattern = (toolArgs.pattern as string) || (details.pattern as string) || "*";
        const targetPath = (toolArgs.path as string) || (details.path as string) || ".";
        lines.push(`${GLYPHS.pass} find: "${pattern}" in ${targetPath}`);
        break;
      }

      case "ls": {
        const targetPath = (toolArgs.path as string) || (details.path as string) || ".";
        const count = details.entries ?? details.count;
        const countStr = count !== undefined ? ` (${count} items)` : "";
        lines.push(`${GLYPHS.pass} ls: ${targetPath}${countStr}`);
        break;
      }

      default: {
        const statusGlyph = entry.isError ? GLYPHS.fail : GLYPHS.pass;
        lines.push(`${statusGlyph} ${toolName}`);
        const contentStr =
          typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content);
        if (contentStr.trim().length > 0) {
          lines.push(`  ${truncateToWidth(contentStr, width - 4)}`);
        }
        break;
      }
    }

    return lines.join("\n");
  }

  // 4. System notices / errors / compaction
  if (entry.role === "system" || entry.isError) {
    const errorPrefix = entry.isError ? `${GLYPHS.warning} ` : `${GLYPHS.middleDot} `;
    const contentStr =
      typeof entry.content === "string" ? entry.content : String(entry.content || "");
    const msgLines = contentStr.split("\n");
    for (let i = 0; i < msgLines.length; i++) {
      const p = i === 0 ? errorPrefix : "  ";
      lines.push(truncateToWidth(`${p}${msgLines[i]}`, width));
    }
    return lines.join("\n");
  }

  // Fallback generic renderer
  const fallbackStr =
    typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content);
  return truncateToWidth(fallbackStr, width);
}

/**
 * Registers entry renderer with pi ExtensionAPI.
 */
export function registerCloudRenderers(pi: unknown): void {
  if (
    !pi ||
    typeof (pi as { registerEntryRenderer?: unknown }).registerEntryRenderer !== "function"
  ) {
    return;
  }

  const registerFn = (
    pi as {
      registerEntryRenderer: (
        customType: string,
        renderer: (entry: unknown, options?: unknown) => unknown,
      ) => void;
    }
  ).registerEntryRenderer;

  registerFn("cloud-msg", (rawEntry: unknown, options?: unknown) => {
    const entry =
      (rawEntry as { data?: CloudMessageEntry })?.data || (rawEntry as CloudMessageEntry);
    if (!entry) return undefined;

    const optObj = (options as EntryRenderSettings) || {};
    return formatCloudMessage(entry, optObj);
  });
}
