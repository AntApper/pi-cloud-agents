/**
 * Deterministic image ZIP builder for pi-cloud-agents Lambda MicroVM (T2.9).
 * Builds dist/image/app.zip with fixed mtimes and reproducible SHA256 containing:
 *  - Dockerfile at root
 *  - runner.js (bundled runner)
 *  - askpass.sh (git credentials helper)
 *  - pi-extensions/ (in-VM extensions)
 * Generates dist/image/manifest.json.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ZipEntry, createDeterministicZip } from "../core/aws/zip.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

export const DETERMINISTIC_BUILD_DATE = new Date("2026-01-01T00:00:00.000Z");
export const PINNED_PI_VERSION = "0.85.1";
export const RUNNER_VERSION = "0.1.0";
export const MAX_IMAGE_ZIP_BYTES = 5 * 1024 * 1024; // 5 MB

export interface ImageBuildResult {
  zipPath: string;
  manifestPath: string;
  sha256: string;
  sizeBytes: number;
  piVersion: string;
  runnerVersion: string;
  builtAt: string;
  entries: string[];
}

export function generateAskpassScript(): string {
  return [
    "#!/bin/sh",
    "# pi-cloud-agents GIT_ASKPASS credential helper",
    'if [ -n "$GITHUB_TOKEN" ]; then',
    '  exec echo "$GITHUB_TOKEN"',
    'elif [ -n "$GH_TOKEN" ]; then',
    '  exec echo "$GH_TOKEN"',
    "else",
    '  exec echo ""',
    "fi",
    "",
  ].join("\n");
}

/**
 * Builds deterministic dist/image/app.zip and dist/image/manifest.json.
 */
export async function buildImageZip(
  options: {
    runnerBundlePath?: string;
    dockerfilePath?: string;
    outputDir?: string;
  } = {},
): Promise<ImageBuildResult> {
  const runnerBundlePath =
    options.runnerBundlePath ?? path.join(REPO_ROOT, "dist", "runner", "index.js");
  const dockerfilePath = options.dockerfilePath ?? path.join(REPO_ROOT, "image", "Dockerfile");
  const outputDir = options.outputDir ?? path.join(REPO_ROOT, "dist", "image");

  if (!fs.existsSync(dockerfilePath)) {
    throw new Error(`Dockerfile not found at ${dockerfilePath}`);
  }

  if (!fs.existsSync(runnerBundlePath)) {
    throw new Error(`Bundled runner not found at ${runnerBundlePath}. Run bundle step first.`);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const dockerfileContent = fs.readFileSync(dockerfilePath, "utf8");
  const runnerContent = fs.readFileSync(runnerBundlePath);
  const askpassContent = generateAskpassScript();

  const entries: ZipEntry[] = [
    {
      name: "Dockerfile",
      content: dockerfileContent,
      mode: 0o644,
      mtime: DETERMINISTIC_BUILD_DATE,
    },
    {
      name: "runner.js",
      content: runnerContent,
      mode: 0o755,
      mtime: DETERMINISTIC_BUILD_DATE,
    },
    {
      name: "askpass.sh",
      content: askpassContent,
      mode: 0o755,
      mtime: DETERMINISTIC_BUILD_DATE,
    },
  ];

  // Include in-VM pi extensions
  const extensionsDir = path.join(REPO_ROOT, "runner", "pi-extensions");
  if (fs.existsSync(extensionsDir)) {
    const extFiles = fs.readdirSync(extensionsDir);
    for (const file of extFiles) {
      if (file.endsWith(".ts") || file.endsWith(".js")) {
        const filePath = path.join(extensionsDir, file);
        const content = fs.readFileSync(filePath, "utf8");
        entries.push({
          name: `pi-extensions/${file}`,
          content,
          mode: 0o644,
          mtime: DETERMINISTIC_BUILD_DATE,
        });
      }
    }
  }

  // Create deterministic ZIP buffer
  const zipBuffer = createDeterministicZip(entries, {
    defaultMtime: DETERMINISTIC_BUILD_DATE,
  });

  if (zipBuffer.length > MAX_IMAGE_ZIP_BYTES) {
    throw new Error(
      `Image ZIP artifact size (${zipBuffer.length} bytes) exceeds maximum allowable limit of ${MAX_IMAGE_ZIP_BYTES} bytes (5 MB)`,
    );
  }

  const sha256 = crypto.createHash("sha256").update(zipBuffer).digest("hex");
  const zipPath = path.join(outputDir, "app.zip");
  fs.writeFileSync(zipPath, zipBuffer);

  const manifest = {
    sha256,
    piVersion: PINNED_PI_VERSION,
    runnerVersion: RUNNER_VERSION,
    builtAt: DETERMINISTIC_BUILD_DATE.toISOString(),
  };

  const manifestPath = path.join(outputDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    zipPath,
    manifestPath,
    sha256,
    sizeBytes: zipBuffer.length,
    piVersion: PINNED_PI_VERSION,
    runnerVersion: RUNNER_VERSION,
    builtAt: DETERMINISTIC_BUILD_DATE.toISOString(),
    entries: entries.map((e) => e.name),
  };
}

// CLI execution
if (
  process.argv[1] &&
  (process.argv[1].endsWith("build-image-zip.ts") || process.argv[1].endsWith("build-image-zip.js"))
) {
  buildImageZip()
    .then((res) => {
      console.log("Built deterministic image ZIP:");
      console.log(`  Artifact: ${res.zipPath} (${res.sizeBytes} bytes)`);
      console.log(`  SHA256:   ${res.sha256}`);
      console.log(`  Entries:  ${res.entries.join(", ")}`);
    })
    .catch((err) => {
      console.error("Failed to build image zip:", err);
      process.exit(1);
    });
}
