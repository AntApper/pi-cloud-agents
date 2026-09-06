#!/usr/bin/env node
/**
 * AWS Kill-Switch: Cleanup test resources (T0.2)
 *
 * Usage:
 *   npm run aws:cleanup -- [--region <R>] [--profile <P>] [--dry-run] [--all] [--json]
 */

import { formatCleanupTable, runAwsCleanup } from "../core/aws/cleanup.js";

interface CliArgs {
  region?: string;
  profile?: string;
  dryRun?: boolean;
  all?: boolean;
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
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--all") {
      args.all = true;
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
AWS Kill-switch Cleanup (pi-cloud-agents T0.2)

Usage:
  npm run aws:cleanup -- [options]

Options:
  --region, -r <region>    AWS region to scan and clean (default: us-east-1 or AWS_REGION)
  --profile, -p <profile>  AWS credentials profile
  --dry-run                Scan and list test resources without modifying or deleting them
  --all                    Clean test images, CloudFormation stacks, secrets, SSM params, and S3 buckets
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

  const report = await runAwsCleanup({
    region: args.region,
    profile: args.profile,
    dryRun: args.dryRun,
    all: args.all,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatCleanupTable(report));
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected failure in aws-cleanup:", err);
  process.exit(1);
});
