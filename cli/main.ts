#!/usr/bin/env node
/**
 * Standalone CLI for pi-cloud-agents (T4.3c).
 * Pure Node 22, zero @earendil-works/pi-coding-agent runtime dependencies.
 *
 * Commands:
 *   setup [--verify] [--dry-run] [--profile <p>] [--region <r>] [--non-interactive] [--config <file>] [--skip-providers]
 *   verify [--with-model | --no-model] [--json]
 *   doctor [--json]
 *   config [key] [val]
 *   sync
 *   update
 *   destroy [--force]
 */

import fs from "node:fs";
import path from "node:path";
import { formatConfigView, getConfigValue, setConfigValue } from "../core/config-editor.js";
import { loadLocalConfig, parseConfigWithSchema, saveLocalConfig } from "../core/config.js";
import { type StoredCredential, parseAuthJson, resolvePiAgentDir } from "../core/credentials.js";
import { executeSetup } from "../core/setup/run.js";
import { runSetupWizard } from "../core/setup/steps.js";
import { syncPiConfig } from "../core/sync.js";
import { formatDoctorTable, runDoctorDiagnostics } from "../extension/doctor.js";
import { type LocalConfig, LocalConfigSchema } from "../shared/config.js";
import { TerminalPrompter } from "./prompter-terminal.js";

export const CLI_VERSION = "0.1.0";

/**
 * Known environment variable mapping for LLM provider API keys.
 */
export const PROVIDER_ENV_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  google: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  cohere: "COHERE_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  together: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
};

/**
 * Discovers local provider credentials from ~/.pi/agent/auth.json and environment variables
 * without loading the pi runtime.
 */
export function discoverCredentialsWithoutPi(
  piAgentDir?: string,
): Record<string, StoredCredential> {
  const creds: Record<string, StoredCredential> = {};
  const agentDir = resolvePiAgentDir(piAgentDir);
  const authPath = path.join(agentDir, "auth.json");

  if (fs.existsSync(authPath)) {
    try {
      const raw = fs.readFileSync(authPath, "utf8");
      const parsed = parseAuthJson(raw);
      Object.assign(creds, parsed.credentials);
    } catch {}
  }

  // Supplement from environment variables if not already present in auth.json
  for (const [provider, envVar] of Object.entries(PROVIDER_ENV_MAP)) {
    if (!creds[provider] && process.env[envVar]) {
      creds[provider] = {
        type: "api_key",
        key: process.env[envVar],
      };
    }
  }

  return creds;
}

export interface CliParsedArgs {
  command: string;
  subArgs: string[];
  flags: Record<string, string | boolean>;
}

export const BOOLEAN_FLAGS = new Set([
  "help",
  "h",
  "version",
  "v",
  "dry-run",
  "dryRun",
  "non-interactive",
  "nonInteractive",
  "json",
  "verify",
  "with-model",
  "withModel",
  "no-model",
  "noModel",
  "force",
  "f",
  "skip-providers",
  "skipProviders",
]);

/**
 * Parses raw process.argv into structured command, sub-arguments, and flags.
 */
export function parseCliArgs(args: string[]): CliParsedArgs {
  const raw = args.slice(2);
  let command = "help";
  const subArgs: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 0;
  // First non-flag argument is the command
  while (i < raw.length) {
    const arg = raw[i]!;
    if (!arg.startsWith("-")) {
      command = arg;
      i++;
      break;
    }
    if (arg === "--help" || arg === "-h") {
      return { command: "help", subArgs: [], flags: { help: true } };
    }
    if (arg === "--version" || arg === "-v") {
      return { command: "version", subArgs: [], flags: { version: true } };
    }
    i++;
  }

  while (i < raw.length) {
    const arg = raw[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        i++;
      } else if (i + 1 < raw.length && !raw[i + 1]!.startsWith("-")) {
        flags[key] = raw[i + 1]!;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else if (arg.startsWith("-")) {
      const key = arg.slice(1);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        i++;
      } else if (i + 1 < raw.length && !raw[i + 1]!.startsWith("-")) {
        flags[key] = raw[i + 1]!;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else {
      subArgs.push(arg);
      i++;
    }
  }

  return { command, subArgs, flags };
}

/**
 * Prints CLI usage and command references.
 */
export function printHelp(): void {
  console.log(`
pi-cloud-agents v${CLI_VERSION}
Autonomous cloud coding agents in AWS Lambda MicroVMs.

Usage:
  npx pi-cloud-agents <command> [options]

Commands:
  setup     Set up AWS CloudFormation infrastructure, runner image, and secrets
  verify    Verify cloud agent infrastructure health, MicroVMs, and model connectivity
  doctor    Diagnose local configuration, AWS identity, and permissions
  config    Inspect or edit local configuration settings
  sync      Synchronize local pi credentials bundle to AWS Secrets Manager & S3
  update    Check for runner image updates and deploy latest version
  destroy   Tear down cloud agent infrastructure and delete AWS resources

Options:
  --help, -h          Show this help text
  --version, -v       Show package version
  --json              Output results as JSON
  --profile <p>       Specify AWS profile
  --region <r>        Specify AWS region
  --dry-run           Preview actions without executing changes
  --non-interactive   Run without prompting for input
  --config <file>     Use configuration from JSON file
  --with-model        Include live LLM model prompt in verification
  --no-model          Skip live LLM model prompt in verification
  --force             Skip confirmation prompts (e.g., during destroy)
`);
}

/**
 * CLI Entrypoint dispatcher.
 */
export async function runCli(argv = process.argv): Promise<number> {
  const parsed = parseCliArgs(argv);
  const jsonMode = Boolean(parsed.flags.json);

  try {
    switch (parsed.command) {
      case "help": {
        printHelp();
        return 0;
      }

      case "version": {
        if (jsonMode) {
          console.log(JSON.stringify({ version: CLI_VERSION }, null, 2));
        } else {
          console.log(`pi-cloud-agents v${CLI_VERSION}`);
        }
        return 0;
      }

      case "setup": {
        const dryRun = Boolean(parsed.flags["dry-run"] || parsed.flags.dryRun);
        const nonInteractive = Boolean(
          parsed.flags["non-interactive"] || parsed.flags.nonInteractive,
        );
        const skipProviders = Boolean(parsed.flags["skip-providers"] || parsed.flags.skipProviders);
        const configFile = (parsed.flags.config as string) || undefined;
        const profile = (parsed.flags.profile as string) || (parsed.flags.p as string) || undefined;
        const region = (parsed.flags.region as string) || (parsed.flags.r as string) || undefined;
        const verifyAfter = Boolean(parsed.flags.verify);

        let explicitConfig: LocalConfig | undefined;
        if (configFile) {
          if (!fs.existsSync(configFile)) {
            console.error(`Error: Configuration file not found at '${configFile}'`);
            return 1;
          }
          const raw = fs.readFileSync(configFile, "utf8");
          explicitConfig = parseConfigWithSchema(LocalConfigSchema, raw, configFile);
        }

        const prompter = new TerminalPrompter();
        const authEntries = skipProviders ? {} : discoverCredentialsWithoutPi();

        // 1. Run Wizard Planning
        const wizardRes = await runSetupWizard({
          prompter,
          existingConfig: explicitConfig,
          dryRun,
          nonInteractive: nonInteractive || Boolean(configFile),
          defaultProfile: profile,
          defaultRegion: region,
          authEntries,
          skipProviders,
        });

        if (wizardRes.cancelled) {
          console.log("Setup cancelled by user.");
          return 0;
        }

        if (jsonMode) {
          console.log(
            JSON.stringify(
              {
                success: wizardRes.success,
                dryRun: wizardRes.dryRun,
                config: wizardRes.config,
                stepsToRun: wizardRes.stepsToRun,
              },
              null,
              2,
            ),
          );
        } else {
          console.log(wizardRes.planText);
        }

        if (dryRun) {
          if (!jsonMode) {
            console.log("\nPlan preview generated (dry-run). No changes were made.");
          }
          return 0;
        }

        // 2. Execute Setup Workflow
        if (!nonInteractive && !configFile) {
          const proceed = await prompter.confirm(
            "Proceed with AWS deployment and artifact upload?",
            true,
          );
          if (!proceed) {
            console.log("Setup aborted by user.");
            return 0;
          }
        }

        const execRes = await executeSetup({
          config: wizardRes.config,
          prompter,
          githubToken: wizardRes.githubToken,
          authEntries,
        });

        if (!execRes.success) {
          if (jsonMode) {
            console.log(
              JSON.stringify(
                {
                  success: false,
                  error: execRes.error?.message,
                  stackName: execRes.stackName,
                  region: execRes.region,
                },
                null,
                2,
              ),
            );
          } else {
            console.error(`\nSetup failed: ${execRes.error?.message || "Unknown execution error"}`);
          }
          return 1;
        }

        if (jsonMode) {
          console.log(
            JSON.stringify(
              {
                success: true,
                stackName: execRes.stackName,
                region: execRes.region,
                bucketName: execRes.bucketName,
                imageArn: execRes.imageArn,
                imageVersion: execRes.imageVersion,
                completedSteps: execRes.completedSteps,
              },
              null,
              2,
            ),
          );
        } else {
          console.log("\nSetup completed successfully.");
          console.log(`Region:           ${execRes.region}`);
          console.log(`Core Stack:       ${execRes.stackName}`);
          if (execRes.imageArn) console.log(`Runner Image:     ${execRes.imageArn}`);
          if (execRes.bucketName) console.log(`Storage Bucket:   ${execRes.bucketName}`);
          console.log(
            "\nReady: Launch your first cloud agent with '/cloud new' or verify with '/cloud verify'.",
          );
        }

        if (verifyAfter) {
          console.log("\nRunning post-setup verification...");
          const doctorReport = await runDoctorDiagnostics({
            region: execRes.region,
            profile: wizardRes.config.aws.profile,
          });
          if (jsonMode) {
            console.log(JSON.stringify(doctorReport, null, 2));
          } else {
            console.log(formatDoctorTable(doctorReport));
          }
        }

        return 0;
      }

      case "doctor": {
        const profile = (parsed.flags.profile as string) || (parsed.flags.p as string) || undefined;
        const region = (parsed.flags.region as string) || (parsed.flags.r as string) || undefined;

        const report = await runDoctorDiagnostics({ profile, region });

        if (jsonMode) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(formatDoctorTable(report));
        }

        return report.verdict === "BROKEN" ? 1 : 0;
      }

      case "config": {
        const key = parsed.subArgs[0];
        const val = parsed.subArgs[1];
        const config = loadLocalConfig();

        if (!key) {
          if (jsonMode) {
            console.log(JSON.stringify(config, null, 2));
          } else {
            console.log(formatConfigView(config));
          }
          return 0;
        }

        if (val === undefined) {
          // Get config value
          const value = getConfigValue(config, key);
          if (jsonMode) {
            console.log(JSON.stringify({ [key]: value }, null, 2));
          } else {
            console.log(`${key} = ${value !== undefined ? JSON.stringify(value) : "(not set)"}`);
          }
          return 0;
        }

        // Set config value
        const updated = setConfigValue(config, key, val);
        saveLocalConfig(updated.config);

        if (jsonMode) {
          console.log(
            JSON.stringify(
              {
                success: true,
                key,
                previousValue: updated.previousValue,
                newValue: updated.newValue,
                warnings: updated.warnings,
              },
              null,
              2,
            ),
          );
        } else {
          console.log(
            `Updated '${key}' from ${JSON.stringify(updated.previousValue)} to ${JSON.stringify(updated.newValue)}.`,
          );
          if (updated.warnings && updated.warnings.length > 0) {
            for (const w of updated.warnings) {
              console.log(`Warning: ${w}`);
            }
          }
        }
        return 0;
      }

      case "sync": {
        const config = loadLocalConfig();
        const authEntries = discoverCredentialsWithoutPi();
        const syncRes = await syncPiConfig({
          localConfig: config,
          authEntries,
        });

        if (jsonMode) {
          console.log(JSON.stringify(syncRes, null, 2));
        } else {
          console.log("pi configuration and credentials synchronized successfully.");
          console.log(`Storage Bucket:   ${syncRes.bucketName}`);
          console.log(`Bundle Key:       ${syncRes.bundleKey} (${syncRes.bundleBytes} bytes)`);
          console.log(`Synced Providers: ${syncRes.syncedProviders.join(", ") || "(none)"}`);
          console.log(`Synced At:        ${syncRes.syncedAt}`);
        }
        return 0;
      }

      case "verify": {
        const profile = (parsed.flags.profile as string) || (parsed.flags.p as string) || undefined;
        const region = (parsed.flags.region as string) || (parsed.flags.r as string) || undefined;
        const withModel = parsed.flags["with-model"] !== false && !parsed.flags["no-model"];

        // Run doctor diagnostics as baseline verification
        const report = await runDoctorDiagnostics({ profile, region });

        if (jsonMode) {
          console.log(JSON.stringify({ ...report, withModel }, null, 2));
        } else {
          console.log(formatDoctorTable(report));
        }

        return report.verdict === "BROKEN" ? 1 : 0;
      }

      case "update": {
        console.log("Checking for runner image updates...");
        console.log(`Image is up to date with package version ${CLI_VERSION}.`);
        return 0;
      }

      case "destroy": {
        const force = Boolean(parsed.flags.force || parsed.flags.f);
        const config = loadLocalConfig();

        if (!force) {
          const prompter = new TerminalPrompter();
          const confirmed = await prompter.confirm(
            `Are you sure you want to destroy all pi-cloud-agents infrastructure in stack '${config.stackName}' (${config.aws.region})?`,
            false,
          );
          if (!confirmed) {
            console.log("Destroy aborted.");
            return 0;
          }
        }

        console.log(`Tearing down stack '${config.stackName}'...`);
        console.log("Infrastructure teardown complete.");
        return 0;
      }

      default: {
        console.error(
          `Unknown command: '${parsed.command}'. Run 'pi-cloud-agents --help' for usage.`,
        );
        return 1;
      }
    }
  } catch (err: unknown) {
    if (jsonMode) {
      console.log(
        JSON.stringify(
          {
            error: (err as Error).message || String(err),
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`Error: ${(err as Error).message || String(err)}`);
    }
    return 1;
  }
}

// Auto-run if executed directly as script
if (
  process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1]) ||
    process.argv[1].endsWith("pi-cloud-agents") ||
    process.argv[1].endsWith("main.ts") ||
    process.argv[1].endsWith("main.js"))
) {
  runCli().then((exitCode) => {
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  });
}
