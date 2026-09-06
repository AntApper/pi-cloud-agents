/**
 * Remote Mirror Session Footer Renderer (T4.7c).
 * Formats responsive, width-safe status footer per 07-ux-and-observability.md §2.5.
 */

import type { PiUiContext } from "../../prompter-pi.js";
import { GLYPHS, badge, truncateToWidth, visibleWidth } from "../kit.js";

export interface RemoteFooterState {
  runId: string;
  status: string;
  activity?: string;
  currentTool?: string;
  currentToolElapsed?: string;
  turns?: number;
  tokens?: string;
  cost?: string;
  contextPct?: number;
  uptime?: string;
  lastEventAge?: string;
  model?: string;
  thinking?: string;
}

export interface FormattedFooterResult {
  left: string;
  right: string;
  full: string;
}

/**
 * Formats the responsive remote mirror session footer.
 */
export function formatRemoteFooter(
  state: RemoteFooterState,
  options: { width?: number } = {},
): FormattedFooterResult {
  const width = options.width ?? 80;
  const statusBadge = badge(state.status);
  const dot = ` ${GLYPHS.middleDot} `;

  // Right side: model + thinking
  const rightParts: string[] = [];
  if (state.model) {
    rightParts.push(state.model.replace("anthropic/", "").replace("openai/", ""));
  }
  if (state.thinking) {
    rightParts.push(`thinking ${state.thinking}`);
  }
  const rightText = rightParts.join(dot);
  const rightWidth = visibleWidth(rightText);

  // Left side components
  const leftSegments: string[] = [`cloud ${state.runId}`, statusBadge];

  if (state.currentTool) {
    const toolElapsed = state.currentToolElapsed ? ` ${state.currentToolElapsed}` : "";
    leftSegments.push(`${state.currentTool}${toolElapsed}`);
  } else if (state.activity && state.activity !== state.status) {
    leftSegments.push(state.activity);
  }

  if (state.turns !== undefined) {
    leftSegments.push(`turn ${state.turns}`);
  }

  if (state.tokens) {
    leftSegments.push(`${state.tokens} tok`);
  }

  if (state.cost) {
    leftSegments.push(state.cost.replace(" est.", ""));
  }

  if (state.contextPct !== undefined) {
    leftSegments.push(`ctx ${state.contextPct}%`);
  }

  if (state.uptime) {
    leftSegments.push(`vm ${state.uptime}`);
  }

  if (state.lastEventAge) {
    leftSegments.push(`live ${state.lastEventAge}`);
  }

  // Construct left side text
  let leftText = leftSegments.join(dot);

  // If width is constrained (e.g. 80 columns), progressively drop low-priority segments
  if (width < 100) {
    // Compact column layout: keep runId, status, activity/tool, turns, cost, context, live
    const compactSegments: string[] = [`cloud ${state.runId}`, statusBadge];
    if (state.currentTool) {
      compactSegments.push(state.currentTool);
    }
    if (state.turns !== undefined) {
      compactSegments.push(`turn ${state.turns}`);
    }
    if (state.cost) {
      compactSegments.push(state.cost.replace(" est.", ""));
    }
    if (state.contextPct !== undefined) {
      compactSegments.push(`ctx ${state.contextPct}%`);
    }
    if (state.lastEventAge) {
      compactSegments.push(`live ${state.lastEventAge}`);
    }

    leftText = compactSegments.join(dot);
  }

  // Align left and right across width
  const leftW = visibleWidth(leftText);
  const availableSpace = width - leftW - rightWidth;

  let full = "";
  if (availableSpace >= 2) {
    const spacePadding = " ".repeat(availableSpace);
    full = `${leftText}${spacePadding}${rightText}`;
  } else {
    // If overflowing, truncate left side and append right side
    const maxLeftWidth = Math.max(20, width - rightWidth - 2);
    const truncatedLeft = truncateToWidth(leftText, maxLeftWidth);
    const space = Math.max(1, width - visibleWidth(truncatedLeft) - rightWidth);
    full = `${truncatedLeft}${" ".repeat(space)}${rightText}`;
  }

  return {
    left: leftText,
    right: rightText,
    full: truncateToWidth(full, width),
  };
}

/**
 * Updates the remote footer in the active pi UI context.
 */
export function updateRemoteFooter(
  ctx: PiUiContext,
  state: RemoteFooterState,
  options: { width?: number } = {},
): void {
  if (ctx.hasUI && ctx.ui && typeof ctx.ui.setFooter === "function") {
    const formatted = formatRemoteFooter(state, options);
    ctx.ui.setFooter(formatted.full);
  }
}
