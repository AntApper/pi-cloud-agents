#!/usr/bin/env node
/**
 * Gate G3: Live Infrastructure Smoke Test CLI runner.
 *
 * Usage:
 *   npm run e2e:aws -- [--region <R>] [--profile <P>] [--simulate] [--live] [--json]
 *   PI_CLOUD_E2E=1 npm run e2e:aws -- [--region <R>]
 */

import { formatInfraSmokeReport, runInfraSmoke } from "../core/aws/infra-smoke.js";

interface CliArgs {
  region?: string;
  profile?: string;
  simulate?: boolean;
  live?: boolean;
  keepResources?: boolean;
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
Gate G3: Live AWS Infrastructure Smoke Test (pi-cloud-agents G3)

Usage:
  npm run e2e:aws -- [options]

Options:
  --region, -r <region>    AWS target region (default: us-east-1 or AWS_REGION)
  --profile, -p <profile>  AWS credentials profile
  --simulate, --dry-run    Force simulated mode (in-memory mock, zero AWS cost)
  --live                   Force live AWS execution (requires AWS credentials)
  --keep-resources         Skip automatic teardown of created stacks and resources
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
    const report = await runInfraSmoke({
      region: args.region,
      profile: args.profile,
      simulate,
      live: isE2e,
      keepResources: args.keepResources,
    });

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatInfraSmokeReport(report));
    }

    if (report.overallStatus === "FAIL") {
      process.exit(1);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nSmoke test execution error: ${msg}`);
    if (process.env.DEBUG && err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
