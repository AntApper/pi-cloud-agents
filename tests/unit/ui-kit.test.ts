import { describe, expect, it } from "vitest";
import {
  GLYPHS,
  badge,
  box,
  bytes,
  duration,
  kv,
  money,
  padToWidth,
  pct,
  sparkline,
  stepList,
  stripAnsi,
  table,
  timeline,
  truncateToWidth,
  visibleWidth,
} from "../../extension/ui/kit.js";

describe("UI Kit Typography & Helpers (T4.1b)", () => {
  describe("Allowed Glyph Constants (§1.1)", () => {
    it("contains all allowed glyph constants and no forbidden emojis", () => {
      expect(GLYPHS.running).toBe("●");
      expect(GLYPHS.idle).toBe("○");
      expect(GLYPHS.suspended).toBe("◌");
      expect(GLYPHS.warning).toBe("▲");
      expect(GLYPHS.pass).toBe("✓");
      expect(GLYPHS.fail).toBe("✗");
      expect(GLYPHS.arrowRight).toBe("→");
      expect(GLYPHS.middleDot).toBe("·");
      expect(GLYPHS.sparkline).toHaveLength(8);
      expect(GLYPHS.border.topLeft).toBe("┌");
      expect(GLYPHS.border.horizontal).toBe("─");
    });
  });

  describe("ANSI & Width Calculation Helpers", () => {
    it("strips ANSI escape codes cleanly", () => {
      const styled = "\x1b[31;1mRed Bold Text\x1b[0m";
      expect(stripAnsi(styled)).toBe("Red Bold Text");
    });

    it("calculates visible terminal column width correctly", () => {
      expect(visibleWidth("Hello")).toBe(5);
      expect(visibleWidth("\x1b[32m● running\x1b[0m")).toBe(9);
      expect(visibleWidth("✓ PASS")).toBe(6);
    });

    it("truncates strings to target width safely", () => {
      expect(truncateToWidth("Hello World", 8)).toBe("Hello W…");
      expect(truncateToWidth("Short", 10)).toBe("Short");
      expect(truncateToWidth("ExactLen", 8)).toBe("ExactLen");
      expect(truncateToWidth("Long String", 4, "")).toBe("Long");
    });

    it("pads strings with alignment (left, right, center)", () => {
      expect(padToWidth("Text", 10, "left")).toBe("Text      ");
      expect(padToWidth("Text", 10, "right")).toBe("      Text");
      expect(padToWidth("Text", 10, "center")).toBe("   Text   ");
    });
  });

  describe("State Badges (§1.1 & §2.7)", () => {
    it("generates correct glyph and label badges", () => {
      expect(badge("running")).toBe("● running");
      expect(badge("idle")).toBe("○ idle");
      expect(badge("suspended")).toBe("◌ suspended");
      expect(badge("failed")).toBe("▲ failed");
      expect(badge("ready")).toBe("✓ ready");
      expect(badge("completed")).toBe("✓ completed");
      expect(badge("running", { glyphOnly: true })).toBe("●");
    });
  });

  describe("Formatters: duration, bytes, money, pct, kv, timeline", () => {
    it("formats duration across all scales", () => {
      expect(duration(120)).toBe("120 ms");
      expect(duration(2100)).toBe("2.1s");
      expect(duration(192000)).toBe("3m 12s");
      expect(duration(2520000)).toBe("42m");
      expect(duration(8100000)).toBe("2h 15m");
    });

    it("formats bytes into human units", () => {
      expect(bytes(512)).toBe("512 B");
      expect(bytes(4300)).toBe("4.2 KB");
      expect(bytes(19400000)).toBe("18.5 MB");
      expect(bytes(1288490188)).toBe("1.2 GB");
    });

    it("formats money with mandatory 'est.' label (§1.0)", () => {
      expect(money(0.91)).toBe("$0.91 est.");
      expect(money(0.0188)).toBe("$0.0188 est.");
      expect(money(12.5)).toBe("$12.50 est.");
    });

    it("formats percentages", () => {
      expect(pct(0.31)).toBe("31%");
      expect(pct(31)).toBe("31%");
      expect(pct(0.999)).toBe("100%");
    });

    it("formats key-value pairs", () => {
      const line = kv("model", "anthropic/claude-sonnet-4-6", { keyWidth: 12 });
      expect(line).toBe("model        anthropic/claude-sonnet-4-6");
    });

    it("formats timelines with arrow separators", () => {
      const t = timeline([
        { name: "launch" },
        { name: "running", durationMs: 2100 },
        { name: "run hook", durationMs: 400 },
        { name: "ready", durationMs: 51900 },
      ]);
      expect(t).toBe("launch → running 2.1s → run hook 400 ms → ready 51.9s");
    });
  });

  describe("Sparklines & Step Lists (§2.4 & §2.6)", () => {
    it("generates 8-level sparklines from values", () => {
      const data = [0, 1, 2, 3, 4, 5, 6, 7];
      const spark = sparkline(data);
      expect(spark).toHaveLength(8);
      expect(spark[0]).toBe(" ");
      expect(spark[7]).toBe("█");
    });

    it("resamples sparklines to target width", () => {
      const data = [10, 20, 50, 100, 20, 5];
      const spark = sparkline(data, 12);
      expect(spark).toHaveLength(12);
    });

    it("formats step list at 80 and 120 columns", () => {
      const steps = [
        {
          state: "PASS",
          name: "AWS identity",
          detail: "arn:aws:iam::…:user/ant (us-east-1)",
          duration: "0.4s",
        },
        {
          state: "IN_PROGRESS",
          name: "Image",
          detail: "building version 13 …",
          eta: "typically 2–3 min",
          duration: "1m 48s",
        },
        { state: "WAITING", name: "Smoke run", detail: "waiting" },
      ];

      const list80 = stepList(steps, { width: 80 });
      expect(list80).toHaveLength(3);
      expect(list80[0]).toContain("✓ AWS identity");
      expect(list80[0]).toContain("0.4s");
      expect(visibleWidth(list80[0]!)).toBeLessThanOrEqual(80);

      const list120 = stepList(steps, { width: 120 });
      expect(list120).toHaveLength(3);
      expect(visibleWidth(list120[1]!)).toBeLessThanOrEqual(120);
    });
  });

  describe("Table Component (§1.0)", () => {
    it("renders aligned Unicode tables at 80 columns", () => {
      const cols = [
        { key: "run", label: "Run ID", width: 10, align: "left" as const },
        { key: "state", label: "State", width: 12, align: "left" as const },
        { key: "model", label: "Model", width: 24, align: "left" as const },
        { key: "cost", label: "Cost", width: 10, align: "right" as const },
      ];

      const rows = [
        { run: "run-001", state: "● running", model: "claude-sonnet-4-6", cost: "$0.91 est." },
        { run: "run-002", state: "○ idle", model: "gpt-4o", cost: "$0.12 est." },
      ];

      const rendered = table({ cols, rows, maxWidth: 80 });
      expect(rendered).toContain("┌────────────┬──────────────┬");
      expect(rendered).toContain("│ run-001    │ ● running    │");
      expect(rendered).toContain("│ run-002    │ ○ idle       │");
      expect(rendered).toContain("└────────────┴──────────────┴");

      for (const line of rendered.split("\n")) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(80);
      }
    });

    it("renders wide tables at 120 columns without overflow", () => {
      const cols = [
        { key: "state", label: "State", width: 14 },
        { key: "run", label: "Run", width: 12 },
        { key: "repo", label: "Repository", width: 36 },
        { key: "activity", label: "Activity", width: 28 },
        { key: "cost", label: "Cost", width: 12, align: "right" as const },
      ];

      const rows = [
        {
          state: "● running",
          run: "7f3a2c",
          repo: "github.com/acme/api#main",
          activity: "tool bash (npm test) 12s",
          cost: "$0.91 est.",
        },
      ];

      const rendered = table({ cols, rows, maxWidth: 120 });
      for (const line of rendered.split("\n")) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(120);
      }
    });
  });

  describe("Box Frame Container (§1.0)", () => {
    it("wraps content in responsive frame with title and footer", () => {
      const content = [
        "New run                 start a cloud agent on this repository",
        "Runs (3)                2 running · 1 idle",
        "Dashboard               live VM and agent statistics",
      ];

      const framed80 = box(content, {
        title: "pi cloud agents",
        footer: "↑↓ select · enter · esc",
        width: 80,
      });

      expect(framed80).toContain("┌ pi cloud agents ─");
      expect(framed80).toContain("│ New run");
      expect(framed80).toContain("↑↓ select · enter · esc ┘");

      for (const line of framed80.split("\n")) {
        expect(visibleWidth(line)).toBe(80);
      }
    });
  });
});
