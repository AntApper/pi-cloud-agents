#!/usr/bin/env node
/**
 * Spike: AWS Account Readiness Probe (T0.2)
 *
 * Usage:
 *   npm run spike:aws-readiness -- [--region <R>] [--profile <P>] [--json]
 */

import { formatReadinessTable, probeAwsReadiness } from "../../core/aws/readiness.js";

interface CliArgs {
  region?: string;
  profile?: string;
  json?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--region" || arg === "-r") {
      args.region = argv[++i];
    } else if (arg === "--profile" || arg === "-p") {
      args.profile = argv[++i];
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
AWS Account Readiness Probe (pi-cloud-agents spike T0.2)

Usage:
  npm run spike:aws-readiness -- [options]

Options:
  --region, -r <region>    AWS target region (default: us-east-1 or AWS_REGION)
  --profile, -p <profile>  AWS credentials profile
  --json                   Output machine-readable JSON report
  --help, -h               Show this help message
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const report = await probeAwsReadiness({
    region: args.region,
    profile: args.profile,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReadinessTable(report));
  }

  // If identity check failed with no creds, return non-zero exit code or 0 depending on spike behavior
  // For spike probe, exit 0 if probe executed and reported status cleanly.
  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected failure in aws-readiness probe:", err);
  process.exit(1);
});
