/**
 * Professional Typography and TUI Kit for pi-cloud-agents (T4.1b).
 * Strict compliance with 07-ux-and-observability.md §1:
 * - Allowed glyph constants only (NO emojis anywhere)
 * - Width-aware layout and ANSI-safe truncation (responsive at 80 and 120 columns)
 * - Standardized badges, tables, durations, bytes, money, pct, sparklines, and step lists.
 */

// ---------------------------------------------------------------------------
// 1. Allowed Typography Glyphs (07-ux-and-observability.md §1.1)
// ---------------------------------------------------------------------------

export const GLYPHS = {
  // States
  running: "●", // U+25CF (live / active)
  idle: "○", // U+25CB (waiting / idle)
  suspended: "◌", // U+25CC (suspended)
  warning: "▲", // U+25B2 (failed / attention)
  spinner: ["◐", "◓", "◑", "◒"] as const, // U+25D0–U+25D3 (in-progress)

  // Verification & Gates
  pass: "✓", // U+2713 (passed)
  fail: "✗", // U+2717 (failed)

  // Arrows & Separators
  arrowRight: "→", // U+2192
  arrowLeft: "←", // U+2190
  arrowUp: "↑", // U+2191
  arrowDown: "↓", // U+2193
  middleDot: "·", // U+00B7 (separator)
  ellipsis: "…", // U+2026

  // Sparkline Bars (U+2581–U+2588)
  sparkline: [" ", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const,

  // Box Drawing Characters
  border: {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "─",
    vertical: "│",
    cross: "┼",
    tTop: "┬",
    tBottom: "┴",
    tLeft: "├",
    tRight: "┤",
  },
} as const;

// ---------------------------------------------------------------------------
// 2. ANSI-Safe Width & Truncation Helpers
// ---------------------------------------------------------------------------

const ANSI_PATTERN =
  "[\\u001b\\u009b][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%_]*)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%_]*)*)?[\\u0007])|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))";
const ANSI_REGEX = new RegExp(ANSI_PATTERN, "g");

/**
 * Strips ANSI escape codes from string.
 */
export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, "");
}

/**
 * Calculates visible terminal column width of a string (ignoring ANSI codes).
 * Accounts for fullwidth/East Asian characters.
 */
export function visibleWidth(str: string): number {
  const clean = stripAnsi(str);
  let width = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    // Basic East Asian Wide / Fullwidth characters
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * Truncates string to target visible terminal width, appending ellipsis if needed.
 */
export function truncateToWidth(
  str: string,
  maxWidth: number,
  ellipsis: string = GLYPHS.ellipsis,
): string {
  if (maxWidth <= 0) return "";
  const total = visibleWidth(str);
  if (total <= maxWidth) return str;

  const ellipsisWidth = visibleWidth(ellipsis);
  const target = Math.max(0, maxWidth - ellipsisWidth);

  let accumulated = 0;
  let cutIndex = 0;

  for (let i = 0; i < str.length; i++) {
    const char = str[i]!;
    const charWidth = visibleWidth(char);
    if (accumulated + charWidth > target) {
      break;
    }
    accumulated += charWidth;
    cutIndex = i + 1;
  }

  return str.slice(0, cutIndex) + ellipsis;
}

/**
 * Pads string to exact target visible width.
 */
export function padToWidth(
  str: string,
  targetWidth: number,
  align: "left" | "right" | "center" = "left",
): string {
  const current = visibleWidth(str);
  if (current >= targetWidth) return str;

  const diff = targetWidth - current;
  if (align === "left") {
    return str + " ".repeat(diff);
  }
  if (align === "right") {
    return " ".repeat(diff) + str;
  }

  const leftPad = Math.floor(diff / 2);
  const rightPad = diff - leftPad;
  return " ".repeat(leftPad) + str + " ".repeat(rightPad);
}

// ---------------------------------------------------------------------------
// 3. State Badges & Formatting Helpers
// ---------------------------------------------------------------------------

export type RunState =
  | "running"
  | "live"
  | "idle"
  | "waiting"
  | "suspended"
  | "provisioning"
  | "launching"
  | "ready"
  | "completed"
  | "finished"
  | "failed"
  | "error"
  | "terminated"
  | string;

/**
 * Generates formatted status badge: glyph + status label.
 * Example: `● running`, `○ idle`, `◌ suspended`, `▲ failed`, `✓ ready`
 */
export function badge(state: RunState, options?: { glyphOnly?: boolean }): string {
  const norm = (state || "").toLowerCase().trim();

  let glyph: string;
  let label = norm;

  switch (norm) {
    case "running":
    case "live":
    case "active":
      glyph = GLYPHS.running;
      label = "running";
      break;
    case "idle":
    case "waiting":
      glyph = GLYPHS.idle;
      label = "idle";
      break;
    case "suspended":
      glyph = GLYPHS.suspended;
      label = "suspended";
      break;
    case "provisioning":
    case "launching":
      glyph = GLYPHS.spinner[0];
      label = "provisioning";
      break;
    case "ready":
    case "pass":
    case "passed":
      glyph = GLYPHS.pass;
      label = "ready";
      break;
    case "completed":
    case "finished":
      glyph = GLYPHS.pass;
      label = "completed";
      break;
    case "failed":
    case "error":
      glyph = GLYPHS.warning;
      label = "failed";
      break;
    case "terminated":
      glyph = GLYPHS.middleDot;
      label = "terminated";
      break;
    default:
      glyph = GLYPHS.middleDot;
      break;
  }

  if (options?.glyphOnly) {
    return glyph;
  }
  return `${glyph} ${label}`;
}

/**
 * Format durations into human-readable compact strings.
 * Examples: `140 ms`, `2.1s`, `3m 12s`, `2h 15m`
 */
export function duration(ms: number): string {
  if (ms < 0) return "0 ms";
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  const sec = ms / 1000;
  if (sec < 60) {
    return `${sec.toFixed(1)}s`;
  }
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  if (min < 60) {
    return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  }
  const hours = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
}

/**
 * Format byte counts into compact binary sizes.
 * Examples: `512 B`, `4.2 KB`, `18.5 MB`, `1.2 GB`
 */
export function bytes(n: number): string {
  if (n < 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

/**
 * Format USD amount with the mandatory "est." label (§1.0).
 * Examples: `$0.91 est.`, `$0.0188 est.`
 */
export function money(amountUsd: number, options?: { decimals?: number }): string {
  const dec = options?.decimals ?? (amountUsd < 0.1 && amountUsd > 0 ? 4 : 2);
  return `$${amountUsd.toFixed(dec)} est.`;
}

/**
 * Format ratios or percentages (e.g. context percentage).
 * Examples: `31%`
 */
export function pct(value: number): string {
  const percent = value <= 1.0 && value >= 0 ? Math.round(value * 100) : Math.round(value);
  return `${percent}%`;
}

/**
 * Generates an activity sparkline string using Unicode bar levels (U+2581–U+2588).
 */
export function sparkline(values: number[], targetWidth?: number): string {
  if (!values || values.length === 0) {
    return targetWidth ? GLYPHS.sparkline[0].repeat(targetWidth) : "";
  }

  let data = values;
  if (targetWidth && targetWidth > 0 && targetWidth !== values.length) {
    // Resample data to targetWidth using linear interpolation
    data = [];
    const step = (values.length - 1) / Math.max(1, targetWidth - 1);
    for (let i = 0; i < targetWidth; i++) {
      const idx = i * step;
      const lower = Math.floor(idx);
      const upper = Math.min(values.length - 1, Math.ceil(idx));
      const frac = idx - lower;
      const val = (values[lower] ?? 0) * (1 - frac) + (values[upper] ?? 0) * frac;
      data.push(val);
    }
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min;

  return data
    .map((v) => {
      if (range === 0) return GLYPHS.sparkline[0];
      const normalized = Math.max(0, Math.min(1, (v - min) / range));
      const level = Math.min(7, Math.floor(normalized * 8));
      return GLYPHS.sparkline[level]!;
    })
    .join("");
}

/**
 * Key-value pair formatting helper.
 * Example: `kv("repository", "github.com/acme/api#main")`
 */
export function kv(
  key: string,
  value: string,
  options?: { keyWidth?: number; maxWidth?: number },
): string {
  const keyW = options?.keyWidth ?? 12;
  const keyPart = padToWidth(key, keyW, "left");
  const full = `${keyPart} ${value}`;
  if (options?.maxWidth) {
    return truncateToWidth(full, options.maxWidth);
  }
  return full;
}

/**
 * Inline timeline renderer separated by arrows (→).
 * Example: `launch → running 2.1s → run hook 0.4s → ready 51.9s`
 */
export function timeline(
  steps: Array<{ name: string; durationMs?: number; duration?: string; status?: string }>,
): string {
  const items = steps.map((s) => {
    let dur = s.duration;
    if (!dur && s.durationMs !== undefined) {
      dur = duration(s.durationMs);
    }
    return dur ? `${s.name} ${dur}` : s.name;
  });

  return items.join(` ${GLYPHS.arrowRight} `);
}

// ---------------------------------------------------------------------------
// 4. Step List (Verification / Setup Progress Layout §2.6)
// ---------------------------------------------------------------------------

export interface StepListItem {
  state: "PASS" | "FAIL" | "WARN" | "IN_PROGRESS" | "WAITING" | string;
  name: string;
  detail?: string;
  elapsedMs?: number;
  duration?: string;
  eta?: string;
}

/**
 * Formats a multi-step checklist matching the layout in §2.6.
 * Example:
 * ✓ AWS identity            arn:aws:iam::…:user/ant (us-east-1)                     0.4s
 * ◐ Image                   building version 13 … 1m 48s (typically 2–3 min)
 */
export function stepList(steps: StepListItem[], options?: { width?: number }): string[] {
  const width = options?.width ?? 80;
  const lines: string[] = [];

  for (const step of steps) {
    let glyph: string;
    switch (step.state.toUpperCase()) {
      case "PASS":
        glyph = GLYPHS.pass;
        break;
      case "FAIL":
        glyph = GLYPHS.fail;
        break;
      case "WARN":
        glyph = GLYPHS.warning;
        break;
      case "IN_PROGRESS":
        glyph = GLYPHS.spinner[0];
        break;
      default:
        glyph = " ";
        break;
    }

    const namePart = padToWidth(step.name, 24, "left");
    let durPart = step.duration || "";
    if (!durPart && step.elapsedMs !== undefined) {
      durPart = duration(step.elapsedMs);
    }
    if (step.eta) {
      durPart = `${durPart} (${step.eta})`.trim();
    }

    const leftPart = `${glyph} ${namePart}`;
    const leftW = visibleWidth(leftPart);
    const durW = visibleWidth(durPart);

    const availableForDetail = width - leftW - durW - 2;
    const detailPart = step.detail
      ? truncateToWidth(step.detail, Math.max(0, availableForDetail))
      : "";

    const middlePart = padToWidth(detailPart, Math.max(0, width - leftW - durW - 2), "left");
    const fullLine = durPart ? `${leftPart} ${middlePart} ${durPart}` : `${leftPart} ${middlePart}`;
    lines.push(truncateToWidth(fullLine, width));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// 5. Width-Aware Table Component (§1.0)
// ---------------------------------------------------------------------------

export interface TableColumn<T = Record<string, unknown>> {
  key: keyof T | string;
  label: string;
  width?: number;
  minWidth?: number;
  align?: "left" | "right" | "center";
}

export interface TableOptions<T = Record<string, unknown>> {
  cols: TableColumn<T>[];
  rows: T[];
  maxWidth?: number;
  bordered?: boolean;
}

/**
 * Renders a width-aware, aligned Unicode table.
 */
export function table<T extends Record<string, unknown>>(options: TableOptions<T>): string {
  const maxWidth = options.maxWidth ?? 80;
  const bordered = options.bordered ?? true;
  const cols = options.cols;
  const rows = options.rows;

  if (cols.length === 0) return "";

  // 1. Compute column widths
  const computedWidths = cols.map((col) => {
    let max = visibleWidth(col.label);
    for (const row of rows) {
      const val = row[col.key as keyof T];
      const str = val !== undefined && val !== null ? String(val) : "";
      max = Math.max(max, visibleWidth(str));
    }
    const min = col.minWidth ?? 4;
    return Math.max(min, col.width ?? max);
  });

  // Calculate available space
  // Border spacing: "│ " (2) + " │ " (3 each internal) + " │" (2) = 4 + 3*(n-1) = 3*n + 1
  const borderOverhead = bordered ? 3 * cols.length + 1 : cols.length - 1;
  const totalWanted = computedWidths.reduce((a, b) => a + b, 0) + borderOverhead;

  // Scale down if exceeding maxWidth
  if (totalWanted > maxWidth) {
    const availableContent = Math.max(cols.length * 4, maxWidth - borderOverhead);
    const sumContent = computedWidths.reduce((a, b) => a + b, 0);
    for (let i = 0; i < computedWidths.length; i++) {
      const share = (computedWidths[i]! / sumContent) * availableContent;
      computedWidths[i] = Math.max(cols[i]?.minWidth ?? 4, Math.floor(share));
    }
  }

  const { border } = GLYPHS;
  const lines: string[] = [];

  // Top border
  if (bordered) {
    const topSegments = computedWidths.map((w) => border.horizontal.repeat(w + 2));
    lines.push(`${border.topLeft}${topSegments.join(border.tTop)}${border.topRight}`);
  }

  // Header row
  const headerCells = cols.map((col, i) => {
    const w = computedWidths[i]!;
    const txt = truncateToWidth(col.label, w);
    return padToWidth(txt, w, col.align ?? "left");
  });

  if (bordered) {
    lines.push(`${border.vertical} ${headerCells.join(` ${border.vertical} `)} ${border.vertical}`);
    const midSegments = computedWidths.map((w) => border.horizontal.repeat(w + 2));
    lines.push(`${border.tLeft}${midSegments.join(border.cross)}${border.tRight}`);
  } else {
    lines.push(headerCells.join("  "));
  }

  // Data rows
  for (const row of rows) {
    const rowCells = cols.map((col, i) => {
      const w = computedWidths[i]!;
      const val = row[col.key as keyof T];
      const str = val !== undefined && val !== null ? String(val) : "";
      const txt = truncateToWidth(str, w);
      return padToWidth(txt, w, col.align ?? "left");
    });

    if (bordered) {
      lines.push(`${border.vertical} ${rowCells.join(` ${border.vertical} `)} ${border.vertical}`);
    } else {
      lines.push(rowCells.join("  "));
    }
  }

  // Bottom border
  if (bordered) {
    const bottomSegments = computedWidths.map((w) => border.horizontal.repeat(w + 2));
    lines.push(`${border.bottomLeft}${bottomSegments.join(border.tBottom)}${border.bottomRight}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 6. Box Frame Container (§1.0)
// ---------------------------------------------------------------------------

export interface BoxOptions {
  title?: string;
  footer?: string;
  width?: number;
}

/**
 * Wraps content in a bordered Unicode box container (responsive at 80 and 120 columns).
 */
export function box(content: string[] | string, options?: BoxOptions): string {
  const width = options?.width ?? 80;
  const innerWidth = width - 4; // Between "│ " and " │"
  const { border } = GLYPHS;

  const lines: string[] = [];

  // Top header with optional title
  if (options?.title) {
    const titleStr = ` ${options.title} `;
    const remDashes = Math.max(0, width - 2 - visibleWidth(titleStr));
    lines.push(
      `${border.topLeft}${titleStr}${border.horizontal.repeat(remDashes)}${border.topRight}`,
    );
  } else {
    lines.push(`${border.topLeft}${border.horizontal.repeat(width - 2)}${border.topRight}`);
  }

  const rawLines = Array.isArray(content) ? content : content.split("\n");
  for (const raw of rawLines) {
    if (raw.startsWith("├") || raw.startsWith("│")) {
      // Direct pass-through if already framed line
      lines.push(raw);
    } else {
      const truncated = truncateToWidth(raw, innerWidth);
      const padded = padToWidth(truncated, innerWidth, "left");
      lines.push(`${border.vertical} ${padded} ${border.vertical}`);
    }
  }

  // Bottom footer with optional hints
  if (options?.footer) {
    const footerStr = ` ${options.footer} `;
    const remDashes = Math.max(0, width - 2 - visibleWidth(footerStr));
    lines.push(
      `${border.bottomLeft}${border.horizontal.repeat(remDashes)}${footerStr}${border.bottomRight}`,
    );
  } else {
    lines.push(`${border.bottomLeft}${border.horizontal.repeat(width - 2)}${border.bottomRight}`);
  }

  return lines.join("\n");
}
