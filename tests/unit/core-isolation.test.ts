import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Core and CLI isolation rule", () => {
  it("ensures core/ and cli/ do not import @earendil-works/pi-coding-agent at runtime", () => {
    const targetDirs = [path.resolve(process.cwd(), "core"), path.resolve(process.cwd(), "cli")];

    const files: string[] = [];
    function walk(dir: string) {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|js|mjs)$/.test(entry.name)) files.push(full);
      }
    }

    for (const d of targetDirs) {
      walk(d);
    }

    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      expect(content).not.toMatch(/from\s+["']@earendil-works\/pi-coding-agent["']/);
      expect(content).not.toMatch(/require\(["']@earendil-works\/pi-coding-agent["']\)/);
    }
  });
});
