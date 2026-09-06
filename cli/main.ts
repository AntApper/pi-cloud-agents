#!/usr/bin/env node
/**
 * CLI entrypoint for pi-cloud-agents.
 */
export function main(): void {
  console.log("pi-cloud-agents CLI v0.1.0");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  main();
}
