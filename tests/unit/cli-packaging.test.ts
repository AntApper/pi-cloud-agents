import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAll } from "../../scripts/build.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

interface PackageManifest {
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
}

const pkg = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
) as PackageManifest;

describe("T5.10 CLI packaging", () => {
  it("builds the bin target as an executable ESM bundle without a sourcemap", async () => {
    const summary = await buildAll();

    const binRelative = pkg.bin["pi-cloud-agents"];
    expect(binRelative).toBeDefined();
    expect(path.resolve(REPO_ROOT, binRelative!)).toBe(summary.cliBundlePath);
    expect(fs.existsSync(summary.cliBundlePath)).toBe(true);
    expect(fs.existsSync(`${summary.cliBundlePath}.map`)).toBe(false);

    const mode = fs.statSync(summary.cliBundlePath).mode & 0o111;
    expect(mode).not.toBe(0);

    const source = fs.readFileSync(summary.cliBundlePath, "utf8");
    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
    // Nothing from node_modules is inlined: no bundler, no SDK, no build orchestrator.
    expect(source).not.toContain("node_modules/esbuild");
    expect(source).not.toContain("node_modules/@aws-sdk");
    expect(source).not.toContain("scripts/build.ts");
    expect(source).not.toContain("buildImageZip");
    expect(fs.statSync(summary.cliBundlePath).size).toBeLessThan(1024 * 1024);
  });

  it("keeps every external import of the bin resolvable from runtime dependencies", async () => {
    const summary = await buildAll();
    const source = fs.readFileSync(summary.cliBundlePath, "utf8");

    const specifiers = new Set<string>();
    for (const match of source.matchAll(/\bfrom\s+"([^".][^"]*)"/g)) {
      specifiers.add(match[1]!);
    }
    for (const match of source.matchAll(/\bimport\s*\(\s*"([^".][^"]*)"\s*\)/g)) {
      specifiers.add(match[1]!);
    }
    expect(specifiers.size).toBeGreaterThan(0);

    const runtimeDeps = new Set(Object.keys(pkg.dependencies));
    for (const spec of specifiers) {
      if (spec.startsWith("node:")) continue;
      const packageName = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0]!;
      expect(runtimeDeps.has(packageName), `${spec} must be a runtime dependency`).toBe(true);
    }
  });

  it("publishes dist/ and guards npm publish with a build", () => {
    expect(pkg.files).toContain("dist/");
    expect(pkg.scripts.prepublishOnly).toMatch(/npm run build/);

    const dryRun = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const [tarball] = JSON.parse(dryRun) as Array<{ files: Array<{ path: string }> }>;
    const paths = new Set(tarball?.files.map((f) => f.path) ?? []);

    expect(paths.has("dist/cli/main.js")).toBe(true);
    expect(paths.has("dist/cli/main.js.map")).toBe(false);
    expect(paths.has("dist/image/app.zip")).toBe(true);
    expect(paths.has("dist/controller.zip")).toBe(true);
  });

  it("runs the built bin with --version", async () => {
    const summary = await buildAll();
    const output = execFileSync(process.execPath, [summary.cliBundlePath, "--version"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(output).toContain("pi-cloud-agents v");
  });
});
