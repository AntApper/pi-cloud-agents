import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "../../extension/ui/kit.js";
import type { CloudMessageEntry } from "../../extension/ui/mirror.js";
import {
  formatCloudMessage,
  registerCloudRenderers,
} from "../../extension/ui/renderers/cloud-entry.js";
import {
  type RemoteFooterState,
  formatRemoteFooter,
  updateRemoteFooter,
} from "../../extension/ui/renderers/footer.js";
import { findForbiddenGlyphs } from "../../scripts/doc-glyph-scan.js";

describe("T4.7c Rich renderers and remote footer", () => {
  const sampleAssistantMsg: CloudMessageEntry = {
    id: "msg-1",
    runId: "run-7f3a2c",
    role: "assistant",
    content: "I am ready to implement the requested feature.\nFirst I will analyze the codebase.",
    thinking:
      "Let's check the directory structure\nWe should look at src/\nNeed to check package.json\nAll looks good.",
    timestamp: "2026-09-06T12:00:00.000Z",
  };

  const sampleUserMsg: CloudMessageEntry = {
    id: "msg-0",
    runId: "run-7f3a2c",
    role: "user",
    content: "Please build the feature and run tests.",
    timestamp: "2026-09-06T11:59:50.000Z",
  };

  const sampleBashMsg: CloudMessageEntry = {
    id: "tool-bash-1",
    runId: "run-7f3a2c",
    role: "tool",
    toolName: "bash",
    content:
      "Line 1: PASS\nLine 2: PASS\nLine 3: PASS\nLine 4: PASS\nLine 5: PASS\nLine 6: PASS\nLine 7: PASS\nLine 8: PASS\nLine 9: PASS\nLine 10: PASS\nLine 11: Extra output",
    details: {
      command: "npm test",
      exitCode: 0,
      durationMs: 450,
    },
    timestamp: "2026-09-06T12:00:10.000Z",
  };

  const sampleEditMsg: CloudMessageEntry = {
    id: "tool-edit-1",
    runId: "run-7f3a2c",
    role: "tool",
    toolName: "edit",
    content:
      "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,3 +1,4 @@\n import fs from 'fs';\n+import path from 'path';\n const x = 1;",
    details: {
      filePath: "src/index.ts",
      diff: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,3 +1,4 @@\n import fs from 'fs';\n+import path from 'path';\n const x = 1;",
    },
    timestamp: "2026-09-06T12:00:15.000Z",
  };

  const sampleReadMsg: CloudMessageEntry = {
    id: "tool-read-1",
    runId: "run-7f3a2c",
    role: "tool",
    toolName: "read",
    content: "file contents",
    details: { filePath: "src/index.ts", lines: 120 },
    timestamp: "2026-09-06T12:00:12.000Z",
  };

  const sampleGrepMsg: CloudMessageEntry = {
    id: "tool-grep-1",
    runId: "run-7f3a2c",
    role: "tool",
    toolName: "grep",
    content: "matches",
    details: { pattern: "export function", path: "src/", matches: 8 },
    timestamp: "2026-09-06T12:00:14.000Z",
  };

  const sampleErrorMsg: CloudMessageEntry = {
    id: "err-1",
    runId: "run-7f3a2c",
    role: "system",
    content: "Connection to remote MicroVM timed out after 60s.",
    isError: true,
    timestamp: "2026-09-06T12:01:00.000Z",
  };

  it("renders assistant message with thinking blocks at 80 and 120 columns", () => {
    const formatted80 = formatCloudMessage(sampleAssistantMsg, { width: 80, showThinking: true });
    expect(formatted80).toContain("thinking:");
    expect(formatted80).toContain("I am ready to implement");
    for (const line of formatted80.split("\n")) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }

    const formatted120 = formatCloudMessage(sampleAssistantMsg, { width: 120, expanded: true });
    expect(formatted120).toContain("Need to check package.json");
    for (const line of formatted120.split("\n")) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(120);
    }
  });

  it("renders user message with '> ' prefix", () => {
    const formatted = formatCloudMessage(sampleUserMsg, { width: 80 });
    expect(formatted).toContain("> Please build the feature and run tests.");
  });

  it("renders bash tool execution with status glyph, command header, and boxed output", () => {
    const formattedCollapsed = formatCloudMessage(sampleBashMsg, { width: 80, expanded: false });
    expect(formattedCollapsed).toContain("✓ bash: $ npm test (450 ms)");
    expect(formattedCollapsed).toContain("┌");
    expect(formattedCollapsed).toContain("└");
    expect(formattedCollapsed).toContain("lines hidden");

    const formattedExpanded = formatCloudMessage(sampleBashMsg, { width: 80, expanded: true });
    expect(formattedExpanded).toContain("Line 11: Extra output");
  });

  it("renders edit diff with syntax-highlighted headers and diff box", () => {
    const formatted = formatCloudMessage(sampleEditMsg, { width: 80 });
    expect(formatted).toContain("✓ edit: src/index.ts");
    expect(formatted).toContain("diff src/index.ts");
    expect(formatted).toContain("+ import path from 'path';");
  });

  it("renders compact summaries for file tools (read, write, grep, find, ls)", () => {
    const readOut = formatCloudMessage(sampleReadMsg, { width: 80 });
    expect(readOut).toBe("✓ read: src/index.ts (120 lines)");

    const grepOut = formatCloudMessage(sampleGrepMsg, { width: 80 });
    expect(grepOut).toBe('✓ grep: "export function" in src/ (8 matches)');

    const writeMsg: CloudMessageEntry = {
      id: "tool-write-1",
      runId: "run-7f3a2c",
      role: "tool",
      toolName: "write",
      content: "ok",
      details: { filePath: "src/new.ts", bytes: 2048 },
      timestamp: "2026-09-06T12:00:20.000Z",
    };
    expect(formatCloudMessage(writeMsg, { width: 80 })).toBe("✓ write: src/new.ts (2048 bytes)");

    const findMsg: CloudMessageEntry = {
      id: "tool-find-1",
      runId: "run-7f3a2c",
      role: "tool",
      toolName: "find",
      content: "ok",
      details: { pattern: "*.ts", path: "src/" },
      timestamp: "2026-09-06T12:00:22.000Z",
    };
    expect(formatCloudMessage(findMsg, { width: 80 })).toBe('✓ find: "*.ts" in src/');

    const lsMsg: CloudMessageEntry = {
      id: "tool-ls-1",
      runId: "run-7f3a2c",
      role: "tool",
      toolName: "ls",
      content: "ok",
      details: { path: "src/", entries: 12 },
      timestamp: "2026-09-06T12:00:25.000Z",
    };
    expect(formatCloudMessage(lsMsg, { width: 80 })).toBe("✓ ls: src/ (12 items)");
  });

  it("renders error notices with warning glyph", () => {
    const errorOut = formatCloudMessage(sampleErrorMsg, { width: 80 });
    expect(errorOut).toContain("▲ Connection to remote MicroVM timed out after 60s.");
  });

  it("formats responsive remote footer at 80 and 120 columns without overflow", () => {
    const footerState: RemoteFooterState = {
      runId: "7f3a2c",
      status: "running",
      currentTool: "bash 12s",
      turns: 14,
      tokens: "205k",
      cost: "$0.91 est.",
      contextPct: 31,
      uptime: "42m",
      lastEventAge: "1s ago",
      model: "anthropic/claude-sonnet-4-5",
      thinking: "medium",
    };

    // 1. 120 columns test
    const footer120 = formatRemoteFooter(footerState, { width: 120 });
    expect(footer120.left).toContain("cloud 7f3a2c");
    expect(footer120.left).toContain("● running");
    expect(footer120.left).toContain("bash 12s");
    expect(footer120.left).toContain("turn 14");
    expect(footer120.left).toContain("205k tok");
    expect(footer120.left).toContain("$0.91");
    expect(footer120.left).toContain("ctx 31%");
    expect(footer120.left).toContain("vm 42m");
    expect(footer120.left).toContain("live 1s ago");
    expect(footer120.right).toContain("claude-sonnet-4-5 · thinking medium");
    expect(visibleWidth(footer120.full)).toBeLessThanOrEqual(120);

    // 2. 80 columns test
    const footer80 = formatRemoteFooter(footerState, { width: 80 });
    expect(footer80.left).toContain("cloud 7f3a2c");
    expect(footer80.left).toContain("● running");
    expect(footer80.right).toContain("claude-sonnet-4-5 · thinking medium");
    expect(visibleWidth(footer80.full)).toBeLessThanOrEqual(80);
  });

  it("updates remote footer in UI context via setFooter", () => {
    const setFooterSpy = vi.fn();
    const ctx = {
      hasUI: true,
      ui: { setFooter: setFooterSpy },
    };

    const footerState: RemoteFooterState = {
      runId: "7f3a2c",
      status: "running",
      currentTool: "bash 5s",
      turns: 2,
      tokens: "12k",
      cost: "$0.05 est.",
      contextPct: 15,
      uptime: "2m",
      lastEventAge: "2s ago",
      model: "anthropic/claude-sonnet-4-5",
    };

    updateRemoteFooter(ctx, footerState, { width: 80 });
    expect(setFooterSpy).toHaveBeenCalledWith(expect.stringContaining("cloud 7f3a2c"));
  });

  it("verifies zero forbidden emojis or symbols across all renderer outputs", () => {
    const outputs = [
      formatCloudMessage(sampleAssistantMsg, { width: 80 }),
      formatCloudMessage(sampleUserMsg, { width: 80 }),
      formatCloudMessage(sampleBashMsg, { width: 80 }),
      formatCloudMessage(sampleEditMsg, { width: 80 }),
      formatCloudMessage(sampleReadMsg, { width: 80 }),
      formatCloudMessage(sampleGrepMsg, { width: 80 }),
      formatCloudMessage(sampleErrorMsg, { width: 80 }),
      formatRemoteFooter(
        {
          runId: "7f3a2c",
          status: "running",
          currentTool: "bash 12s",
          turns: 14,
          tokens: "205k",
          cost: "$0.91 est.",
          contextPct: 31,
          uptime: "42m",
          lastEventAge: "1s ago",
          model: "anthropic/claude-sonnet-4-5",
          thinking: "medium",
        },
        { width: 80 },
      ).full,
    ].join("\n");

    const violations = findForbiddenGlyphs(outputs);
    expect(violations).toHaveLength(0);
  });

  it("registers entry renderer with ExtensionAPI", () => {
    const registerEntryRendererSpy = vi.fn();
    const mockPi = {
      registerEntryRenderer: registerEntryRendererSpy,
    };

    registerCloudRenderers(mockPi);
    expect(registerEntryRendererSpy).toHaveBeenCalledWith("cloud-msg", expect.any(Function));
  });
});
