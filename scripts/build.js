#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

// Ensure dist directories exist
const root = process.cwd();
const dirs = [
  path.join(root, "dist"),
  path.join(root, "dist/image"),
  path.join(root, "dist/runner"),
  path.join(root, "dist/controller"),
];

for (const dir of dirs) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

console.log("Build completed (scaffold stubs).");
