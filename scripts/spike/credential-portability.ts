#!/usr/bin/env node
/**
 * Spike: pi Credential Portability and Refresh Conflict Probe (T0.6)
 *
 * Usage:
 *   npm run spike:credential-portability -- [--dir <path>] [--sandbox <path>] [--json]
 */

import { formatCredentialPortabilityTable, runCredentialSpike } from "../../core/credentials.js";

interface CliArgs {
  dir?: string;
  sandbox?: string;
  json?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir" || arg === "-d") {
      args.dir = argv[++i];
    } else if (arg === "--sandbox" || arg === "-s") {
      args.sandbox = argv[++i];
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
pi Credential Portability & Refresh Collision Spike (pi-cloud-agents T0.6)

Usage:
  npm run spike:credential-portability -- [options]

Options:
  --dir, -d <path>      Source pi agent directory (default: ~/.pi/agent or PI_CODING_AGENT_DIR)
  --sandbox, -s <path>  Target sandbox directory for export simulation (default: /tmp/pi-cloud-sandbox-<ts>)
  --json                Output machine-readable JSON report
  --help, -h            Show this help message
`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const report = runCredentialSpike({
    piAgentDir: args.dir,
    sandboxDir: args.sandbox,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatCredentialPortabilityTable(report));
  }

  process.exit(0);
}

main();
