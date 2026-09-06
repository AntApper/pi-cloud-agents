import { describe, expect, it } from "vitest";
import {
  badge,
  box,
  bytes,
  duration,
  money,
  pct,
  sparkline,
  stepList,
  table,
} from "../../extension/ui/kit.js";
import { findForbiddenGlyphs, runScan } from "../../scripts/doc-glyph-scan.js";

describe("UI style & doc glyph scanner (T4.1b)", () => {
  it("passes doc glyph scan across all markdown and code files", () => {
    const violations = runScan();
    expect(violations).toBe(0);
  });

  it("detects forbidden emojis and symbols in test input", () => {
    const textWithEmoji = "Hello world 🚀 with fire 🔥 and sparkles ✨";
    const violations = findForbiddenGlyphs(textWithEmoji);
    expect(violations.length).toBeGreaterThanOrEqual(3);
  });

  it("allows allowed glyphs like ✓, ✗, ●, ○, ◌, →, ·, and sparklines", () => {
    const textWithAllowedGlyphs =
      "● running ○ idle ◌ suspended ✓ check ✗ fail → next · separator ▂▃▄▅▆▇█ …";
    const violations = findForbiddenGlyphs(textWithAllowedGlyphs);
    expect(violations.length).toBe(0);
  });

  it("asserts zero forbidden glyphs on all UI kit output components", () => {
    const outputs = [
      badge("running"),
      badge("idle"),
      badge("suspended"),
      badge("failed"),
      badge("ready"),
      duration(123456),
      bytes(1024000),
      money(1.234),
      pct(0.55),
      sparkline([1, 2, 3, 4, 5, 6, 7, 8]),
      table({
        cols: [
          { key: "a", label: "Col A" },
          { key: "b", label: "Col B" },
        ],
        rows: [{ a: "val1", b: "val2" }],
        maxWidth: 80,
      }),
      box(["Item 1", "Item 2"], { title: "Test", footer: "Hint", width: 80 }),
      stepList([
        { state: "PASS", name: "Step 1", detail: "Detail 1", elapsedMs: 500 },
        { state: "FAIL", name: "Step 2", detail: "Detail 2" },
      ]),
    ]
      .flat()
      .join("\n");

    const violations = findForbiddenGlyphs(outputs);
    expect(violations).toHaveLength(0);
  });
});
