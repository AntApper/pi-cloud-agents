/**
 * Build orchestrator for pi-cloud-agents (T2.9 & T3.5).
 *  1. Bundles runner/main.ts -> dist/runner/index.js (esbuild, Node 22, ESM, sourcemap)
 *  2. Bundles infra/controller/handler.ts -> dist/controller/index.js + dist/controller.zip (< 2 MB)
 *  3. Builds dist/image/app.zip (deterministic, < 5 MB) + dist/image/manifest.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { createDeterministicZip } from "../core/aws/zip.js";
import {
  DETERMINISTIC_BUILD_DATE,
  type ImageBuildResult,
  buildImageZip,
} from "./build-image-zip.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

export interface BuildSummary {
  runnerBundlePath: string;
  controllerZipPath: string;
  imageZip: ImageBuildResult;
}

/**
 * Executes full build pipeline.
 */
export async function buildAll(): Promise<BuildSummary> {
  const distDir = path.join(REPO_ROOT, "dist");
  const runnerDir = path.join(distDir, "runner");
  const controllerDir = path.join(distDir, "controller");
  const imageDir = path.join(distDir, "image");

  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(runnerDir, { recursive: true });
  fs.mkdirSync(controllerDir, { recursive: true });
  fs.mkdirSync(imageDir, { recursive: true });

  const runnerEntry = path.join(REPO_ROOT, "runner", "main.ts");
  const runnerOut = path.join(runnerDir, "index.js");

  // 1. Bundle runner using esbuild
  await esbuild.build({
    entryPoints: [runnerEntry],
    outfile: runnerOut,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: "external",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    logLevel: "warning",
  });

  // 2. Bundle controller Lambda using esbuild
  const controllerEntry = path.join(REPO_ROOT, "infra", "controller", "handler.ts");
  const controllerOut = path.join(controllerDir, "index.js");

  await esbuild.build({
    entryPoints: [controllerEntry],
    outfile: controllerOut,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    external: ["@aws-sdk/*"],
    sourcemap: "external",
    logLevel: "warning",
  });

  const controllerCode = fs.readFileSync(controllerOut);
  const controllerZipBuffer = createDeterministicZip(
    [
      {
        name: "index.js",
        content: controllerCode,
        mode: 0o644,
        mtime: DETERMINISTIC_BUILD_DATE,
      },
    ],
    { defaultMtime: DETERMINISTIC_BUILD_DATE },
  );

  const controllerZipPath = path.join(distDir, "controller.zip");
  fs.writeFileSync(controllerZipPath, controllerZipBuffer);

  // 3. Bundle CLI entrypoint using esbuild
  const cliDir = path.join(distDir, "cli");
  fs.mkdirSync(cliDir, { recursive: true });
  const cliEntry = path.join(REPO_ROOT, "cli", "main.ts");
  const cliOut = path.join(cliDir, "main.js");

  await esbuild.build({
    entryPoints: [cliEntry],
    outfile: cliOut,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    sourcemap: "external",
    logLevel: "warning",
  });
  fs.chmodSync(cliOut, 0o755);

  // 4. Build deterministic dist/image/app.zip & manifest.json
  const imageZip = await buildImageZip({
    runnerBundlePath: runnerOut,
    dockerfilePath: path.join(REPO_ROOT, "image", "Dockerfile"),
    outputDir: imageDir,
  });

  return {
    runnerBundlePath: runnerOut,
    controllerZipPath,
    imageZip,
  };
}

// CLI execution
if (
  process.argv[1] &&
  (process.argv[1].endsWith("build.ts") || process.argv[1].endsWith("build.js"))
) {
  buildAll()
    .then((summary) => {
      console.log("Build completed successfully:");
      console.log(`  Runner:     ${summary.runnerBundlePath}`);
      console.log(`  Controller: ${summary.controllerZipPath}`);
      console.log(
        `  Image ZIP:  ${summary.imageZip.zipPath} (${summary.imageZip.sizeBytes} bytes, SHA256: ${summary.imageZip.sha256})`,
      );
    })
    .catch((err) => {
      console.error("Build failed:", err);
      process.exit(1);
    });
}
