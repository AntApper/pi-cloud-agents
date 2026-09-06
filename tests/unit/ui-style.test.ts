import { describe, expect, it } from "vitest";
import { findForbiddenGlyphs, runScan } from "../../scripts/doc-glyph-scan.js";

describe("UI style & doc glyph scanner", () => {
  it("passes doc glyph scan across all markdown and code files", () => {
    const violations = runScan();
    expect(violations).toBe(0);
  });

  it("detects forbidden emojis and symbols in test input", () => {
    const textWithEmoji = "Hello world 🚀 with fire 🔥 and sparkles ✨";
    const violations = findForbiddenGlyphs(textWithEmoji);
    expect(violations.length).toBeGreaterThanOrEqual(3);
  });

  it("allows allowed glyphs like ✓, ✗, ●, ○, ◌, →, ·", () => {
    const textWithAllowedGlyphs = "● running ○ idle ◌ suspended ✓ check ✗ fail → next · separator";
    const violations = findForbiddenGlyphs(textWithAllowedGlyphs);
    expect(violations.length).toBe(0);
  });
});
