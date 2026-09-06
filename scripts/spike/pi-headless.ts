#!/usr/bin/env node
/**
 * Spike: pi headless on ARM64 AL2023 + mock LLM (T0.5)
 *
 * Usage:
 *   npm run spike:pi-headless -- [--region <R>] [--profile <P>] [--simulate] [--json]
 *   PI_CLOUD_E2E=1 npm run spike:pi-headless -- [--region <R>]
 */

import { formatPiHeadlessTable, runPiHeadlessSpike } from "../../core/aws/pi-headless.js";

interface CliArgs {
  region?: string;
  profile?: string;
  simulate?: boolean;
  live?: boolean;
  json?: boolean;
  keepResources?: boolean;
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
    } else if (arg === "--simulate" || arg === "--dry-run") {
      args.simulate = true;
    } else if (arg === "--live") {
      args.live = true;
    } else if (arg === "--keep-resources") {
      args.keepResources = true;
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
Pi Headless & Mock LLM Spike (pi-cloud-agents spike T0.5)

Usage:
  npm run spike:pi-headless -- [options]

Options:
  --region, -r <region>    AWS target region (default: us-east-1 or AWS_REGION)
  --profile, -p <profile>  AWS credentials profile
  --simulate, --dry-run    Force simulated mode (in-memory mock, zero AWS cost)
  --live                   Force live AWS execution (requires AWS credentials)
  --keep-resources         Skip automatic teardown of created resources
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

  const isE2e = process.env.PI_CLOUD_E2E === "1" || args.live === true;
  const simulate = args.simulate ?? !isE2e;

  try {
    const report = await runPiHeadlessSpike({
      region: args.region,
      profile: args.profile,
      simulate,
      keepResources: args.keepResources,
    });

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatPiHeadlessTable(report));
    }

    if (report.verdict === "FAIL") {
      process.exit(1);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nSpike execution error: ${msg}`);
    if (process.env.DEBUG && err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
