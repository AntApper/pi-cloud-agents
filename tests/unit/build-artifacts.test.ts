import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_ZIP_BYTES,
  PINNED_PI_VERSION,
  RUNNER_VERSION,
} from "../../scripts/build-image-zip.js";
import { buildAll } from "../../scripts/build.js";

describe("T2.9 Build Artifacts & Deterministic Image ZIP", () => {
  it("builds clean artifacts into dist/ and verifies sizes under thresholds", async () => {
    const summary = await buildAll();

    expect(fs.existsSync(summary.runnerBundlePath)).toBe(true);
    expect(fs.existsSync(summary.controllerZipPath)).toBe(true);
    expect(fs.existsSync(summary.imageZip.zipPath)).toBe(true);
    expect(fs.existsSync(summary.imageZip.manifestPath)).toBe(true);

    // Verify bundle and zip sizes
    expect(summary.imageZip.sizeBytes).toBeLessThan(MAX_IMAGE_ZIP_BYTES);
    expect(summary.imageZip.sizeBytes).toBeGreaterThan(10000); // at least 10KB

    // Verify manifest contents
    const manifest = JSON.parse(fs.readFileSync(summary.imageZip.manifestPath, "utf8"));
    expect(manifest.sha256).toBe(summary.imageZip.sha256);
    expect(manifest.piVersion).toBe(PINNED_PI_VERSION);
    expect(manifest.runnerVersion).toBe(RUNNER_VERSION);
    expect(manifest.builtAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("produces byte-for-byte identical SHA256 hashes across consecutive builds (deterministic reproducibility)", async () => {
    // Build 1
    const build1 = await buildAll();
    const hash1 = build1.imageZip.sha256;
    const bytes1 = fs.readFileSync(build1.imageZip.zipPath);

    // Build 2
    const build2 = await buildAll();
    const hash2 = build2.imageZip.sha256;
    const bytes2 = fs.readFileSync(build2.imageZip.zipPath);

    expect(hash1).toBe(hash2);
    expect(bytes1.equals(bytes2)).toBe(true);
  });

  it("verifies zip structure contains Dockerfile at root, runner.js, and askpass.sh", async () => {
    const summary = await buildAll();
    const entries = summary.imageZip.entries;

    expect(entries).toContain("Dockerfile");
    expect(entries).toContain("runner.js");
    expect(entries).toContain("askpass.sh");
    expect(entries.some((e) => e.startsWith("pi-extensions/"))).toBe(true);
  });
});
