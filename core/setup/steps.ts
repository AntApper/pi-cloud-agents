/**
 * Setup Wizard Step Machine (T4.3a).
 * Implements Quick Setup (default) and Custom Wizard flow for configuring
 * AWS credentials, MicroVM region, provider syncing, OAuth gating, and operational budgets.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { DEFAULT_LOCAL_CONFIG, type LocalConfig, LocalConfigSchema } from "../../shared/config.js";
import { AwsClientFactory } from "../aws/clients.js";
import { maskAccountId } from "../aws/mask.js";
import { SUPPORTED_MICROVM_REGIONS } from "../aws/readiness.js";
import { formatGitHubSecretName } from "../aws/secrets.js";
import { loadLocalConfig, saveLocalConfig } from "../config.js";
import { type StoredCredential, parseAuthJson, resolvePiAgentDir } from "../credentials.js";
import type { Prompter, SelectOption } from "../prompter.js";

import { DEFAULT_STACK_NAME } from "../sync.js";

export { DEFAULT_STACK_NAME };

export interface SetupWizardOptions {
  prompter: Prompter;
  clientFactory?: AwsClientFactory;
  existingConfig?: LocalConfig;
  dryRun?: boolean;
  nonInteractive?: boolean;
  defaultProfile?: string;
  defaultRegion?: string;
  piAgentDir?: string;
  authEntries?: Record<string, StoredCredential>;
  skipProviders?: boolean;
}

export interface SetupPlanResult {
  success: boolean;
  cancelled?: boolean;
  config: LocalConfig;
  planText: string;
  githubToken?: string;
  dryRun: boolean;
  stepsToRun: string[];
}

/**
 * Discovers available AWS CLI profile names from ~/.aws/config and ~/.aws/credentials.
 */
export function discoverAwsProfiles(): string[] {
  const profiles = new Set<string>();

  if (process.env.AWS_PROFILE) {
    profiles.add(process.env.AWS_PROFILE.trim());
  }

  const homeDir = os.homedir();
  const configFiles = [
    path.join(homeDir, ".aws", "config"),
    path.join(homeDir, ".aws", "credentials"),
  ];

  for (const file of configFiles) {
    if (fs.existsSync(file)) {
      try {
        const content = fs.readFileSync(file, "utf8");
        const lines = content.split("\n");
        for (const line of lines) {
          const match = line.match(/^\s*\[(?:profile\s+)?([^\]]+)\]/);
          if (match?.[1]) {
            profiles.add(match[1].trim());
          }
        }
      } catch {}
    }
  }

  if (profiles.size === 0) {
    profiles.add("default");
  }

  return Array.from(profiles);
}

/**
 * Probes AWS STS caller identity to confirm credentials and retrieve account ID.
 */
export async function probeAwsIdentity(
  factory: AwsClientFactory,
  profile?: string,
  region = "us-east-1",
): Promise<{ accountId?: string; arn?: string; userId?: string; error?: string }> {
  try {
    const stsClient = factory.getSTSClient({ profile, region });
    const res = await stsClient.send(new GetCallerIdentityCommand({}));
    return {
      accountId: res.Account,
      arn: res.Arn,
      userId: res.UserId,
    };
  } catch (err) {
    return {
      error: (err as Error).message,
    };
  }
}

/**
 * Discovers local provider credentials from ~/.pi/agent/auth.json or provided authEntries.
 */
export function discoverLocalProviderIds(options: {
  piAgentDir?: string;
  authEntries?: Record<string, StoredCredential>;
}): {
  all: string[];
  apiKeys: string[];
  oauth: string[];
} {
  let authEntries = options.authEntries;

  if (!authEntries) {
    const agentDir = resolvePiAgentDir(options.piAgentDir);
    const authPath = path.join(agentDir, "auth.json");
    if (fs.existsSync(authPath)) {
      try {
        const raw = fs.readFileSync(authPath, "utf8");
        const parsed = parseAuthJson(raw);
        authEntries = parsed.credentials;
      } catch {
        authEntries = {};
      }
    } else {
      authEntries = {};
    }
  }

  const all: string[] = [];
  const apiKeys: string[] = [];
  const oauth: string[] = [];

  for (const [provider, cred] of Object.entries(authEntries)) {
    all.push(provider);
    if (cred.type === "oauth") {
      oauth.push(provider);
    } else {
      apiKeys.push(provider);
    }
  }

  return { all, apiKeys, oauth };
}

/**
 * Renders a clean formatted summary plan table.
 */
export function formatSetupPlanTable(
  config: LocalConfig,
  identity?: { accountId?: string; arn?: string },
): string {
  const width = 76;
  const lines: string[] = [];
  const title = " pi cloud agents · Setup Plan ";
  const topDashes = Math.max(0, width - 2 - title.length);

  lines.push(`┌${title}${"─".repeat(topDashes)}┐`);

  const profileDisplay = config.aws.profile || "(default)";
  const accountDisplay = identity?.accountId
    ? maskAccountId(identity.accountId)
    : "(active profile)";
  lines.push(`${`│ AWS Profile:        ${profileDisplay} (${accountDisplay})`.padEnd(width - 1)}│`);
  lines.push(`${`│ AWS Region:         ${config.aws.region}`.padEnd(width - 1)}│`);
  lines.push(
    `${`│ Runner Image:       ${config.image.name} (${config.image.memoryMiB} MiB RAM)`.padEnd(width - 1)}│`,
  );
  lines.push(
    `${`│ Max Duration:       ${config.defaults.maxDurationHours} hours (idle suspend: ${config.defaults.idle.suspendAfterMin}m)`.padEnd(width - 1)}│`,
  );
  lines.push(
    `${`│ Concurrency Limit:  ${config.defaults.maxConcurrent} active runs`.padEnd(width - 1)}│`,
  );
  lines.push(`├${"─".repeat(width - 2)}┤`);

  const provStr =
    config.providers.synced.length > 0 ? config.providers.synced.join(", ") : "(none)";
  lines.push(`${`│ Synced Providers:   ${provStr}`.padEnd(width - 1)}│`);

  const oauthStr =
    config.providers.oauthOptIn.length > 0 ? config.providers.oauthOptIn.join(", ") : "(none)";
  lines.push(`${`│ OAuth Opt-Ins:      ${oauthStr}`.padEnd(width - 1)}│`);

  const bedrockStr = config.providers.bedrockRole ? "Enabled" : "Disabled";
  lines.push(`${`│ Amazon Bedrock:     ${bedrockStr}`.padEnd(width - 1)}│`);

  const githubStr =
    config.github.mode === "secret" ? "Configured (Secrets Manager)" : "None (public repos only)";
  lines.push(`${`│ GitHub PAT:         ${githubStr}`.padEnd(width - 1)}│`);
  lines.push(`├${"─".repeat(width - 2)}┤`);
  lines.push(
    `${"│ Estimated Idle Cost: $0.00 / month (zero cost when no runs active)".padEnd(width - 1)}│`,
  );
  lines.push(`└${"─".repeat(width - 2)}┘`);

  return lines.join("\n");
}

/**
 * Runs the setup wizard step machine.
 */
export async function runSetupWizard(options: SetupWizardOptions): Promise<SetupPlanResult> {
  const prompter = options.prompter;
  const factory = options.clientFactory ?? new AwsClientFactory();
  const existingConfig =
    options.existingConfig ?? loadLocalConfig({ customDir: options.piAgentDir });

  // 1. Initial Discovery
  const discoveredProfiles = discoverAwsProfiles();
  const initialProfile =
    options.defaultProfile ??
    existingConfig.aws.profile ??
    (discoveredProfiles.includes("default") ? "default" : discoveredProfiles[0]);
  const initialRegion = options.defaultRegion ?? existingConfig.aws.region ?? "us-east-1";

  const discoveredProviders = discoverLocalProviderIds({
    piAgentDir: options.piAgentDir,
    authEntries: options.authEntries,
  });

  // Default provider selection: all discovered API keys
  const initialSyncedProviders = options.skipProviders
    ? []
    : existingConfig.providers.synced.length > 0
      ? existingConfig.providers.synced
      : discoveredProviders.apiKeys;

  // Probe identity
  const identity = await probeAwsIdentity(factory, initialProfile, initialRegion);

  // Quick setup default configuration candidate
  let workingConfig: LocalConfig = {
    ...DEFAULT_LOCAL_CONFIG,
    ...existingConfig,
    aws: {
      profile: initialProfile === "default" ? undefined : initialProfile,
      region: initialRegion,
    },
    providers: {
      synced: initialSyncedProviders,
      oauthOptIn: existingConfig.providers.oauthOptIn ?? [],
      bedrockRole: existingConfig.providers.bedrockRole ?? false,
    },
  };

  let githubTokenValue: string | undefined;

  if (options.nonInteractive) {
    // Non-interactive path -> accept working configuration directly
    const planText = formatSetupPlanTable(workingConfig, identity);
    if (!options.dryRun) {
      saveLocalConfig(workingConfig, { customDir: options.piAgentDir });
    }
    return {
      success: true,
      config: workingConfig,
      planText,
      dryRun: Boolean(options.dryRun),
      stepsToRun: ["deploy_core", "deploy_image", "sync_bundle"],
    };
  }

  // 2. Quick Setup Summary Screen (Default)
  const quickPlanText = formatSetupPlanTable(workingConfig, identity);
  prompter.note(quickPlanText, "Quick Setup Overview");

  type QuickAction = "create" | "customize" | "cancel";
  const actionChoices: SelectOption<QuickAction>[] = [
    {
      label: "Create (Quick Setup) - Recommended",
      value: "create",
      hint: "Deploy infrastructure with detected defaults",
    },
    { label: "Customize - Configure AWS, providers, and budgets", value: "customize" },
    { label: "Cancel", value: "cancel" },
  ];

  const chosenAction = await prompter.select<QuickAction>(
    "Choose setup action:",
    actionChoices,
    "create",
  );

  if (chosenAction === "cancel") {
    return {
      success: false,
      cancelled: true,
      config: workingConfig,
      planText: quickPlanText,
      dryRun: Boolean(options.dryRun),
      stepsToRun: [],
    };
  }

  if (chosenAction === "customize") {
    // -------------------------------------------------------------------------
    // Custom Wizard Flow
    // -------------------------------------------------------------------------

    // Step 1: AWS Profile & Region
    const profileOptions: SelectOption<string>[] = discoveredProfiles.map((p) => ({
      label: p,
      value: p,
    }));
    profileOptions.push({ label: "Custom profile name...", value: "__custom__" });

    let selectedProfile = await prompter.select(
      "Select AWS Profile:",
      profileOptions,
      initialProfile,
    );

    if (selectedProfile === "__custom__") {
      selectedProfile = await prompter.input("Enter AWS profile name:", {
        defaultValue: "default",
      });
    }

    const regionOptions: SelectOption<string>[] = SUPPORTED_MICROVM_REGIONS.map((r) => ({
      label: r,
      value: r,
      hint: r === "us-east-1" ? "Default / lowest latency" : undefined,
    }));

    const selectedRegion = await prompter.select(
      "Select AWS Region for Lambda MicroVMs:",
      regionOptions,
      initialRegion,
    );

    // Verify identity for chosen profile/region
    const verifiedIdentity = await prompter.progress("Verifying AWS credentials", async () => {
      return probeAwsIdentity(factory, selectedProfile, selectedRegion);
    });

    if (verifiedIdentity.error) {
      prompter.note(
        `Warning: STS identity verification returned error: ${verifiedIdentity.error}`,
        "AWS Verification Notice",
      );
    }

    // Step 2: Providers to Sync
    let syncedProviders: string[] = [];
    const oauthOptInList: string[] = [];

    if (discoveredProviders.all.length > 0) {
      const providerOptions = discoveredProviders.all.map((p) => {
        const isOAuth = discoveredProviders.oauth.includes(p);
        return {
          label: isOAuth ? `${p} [OAuth notice: token invalidation risk]` : p,
          value: p,
          selected: !isOAuth && initialSyncedProviders.includes(p),
        };
      });

      syncedProviders = await prompter.multiselect(
        "Select local provider credentials to sync to cloud agents:",
        providerOptions,
      );

      // Handle OAuth Opt-in Gating with ToS notice
      for (const p of syncedProviders) {
        if (discoveredProviders.oauth.includes(p)) {
          const tosNotice = `Notice for OAuth provider '${p}':\nSyncing OAuth credentials to AWS MicroVMs enables remote token refresh, which invalidates the local session token.\nYou will need to re-login locally if the cloud agent refreshes your token.`;
          prompter.note(tosNotice, "OAuth Token Refresh Notice");

          const confirmed = await prompter.confirm(
            `Opt-in to syncing OAuth credentials for '${p}'?`,
            false,
          );
          if (confirmed) {
            oauthOptInList.push(p);
          } else {
            // Remove from synced list if user declined opt-in
            syncedProviders = syncedProviders.filter((prov) => prov !== p);
          }
        }
      }
    }

    // Bedrock toggle
    const enableBedrock = await prompter.confirm(
      "Enable Amazon Bedrock models via IAM role in MicroVM?",
      workingConfig.providers.bedrockRole,
    );

    // Step 3: GitHub Integration
    type GitHubChoice = "pat" | "skip";
    const ghChoice = await prompter.select<GitHubChoice>(
      "Configure GitHub personal access token (PAT) for private repo cloning?",
      [
        { label: "Paste fine-grained PAT (stored securely in Secrets Manager)", value: "pat" },
        { label: "Skip for now (public repositories only / configure later)", value: "skip" },
      ],
      "skip",
    );

    let githubMode: "secret" | "none" = "none";
    let githubSecretName: string | undefined;

    if (ghChoice === "pat") {
      const pat = await prompter.password(
        "Enter GitHub fine-grained PAT (starts with github_pat_):",
        {
          validate: (val) => (val.length > 0 ? true : "PAT cannot be empty"),
        },
      );
      githubTokenValue = pat;
      githubMode = "secret";
      githubSecretName = formatGitHubSecretName(workingConfig.stackName);
    }

    // Step 4: Sizing & Budgets
    const maxDurationStr = await prompter.input("Maximum run duration in hours (1-8):", {
      defaultValue: String(workingConfig.defaults.maxDurationHours),
      validate: (v) => {
        const n = Number(v);
        return !Number.isNaN(n) && n >= 1 && n <= 8 ? true : "Enter a number between 1 and 8";
      },
    });

    const idleSuspendStr = await prompter.input(
      "Idle duration in minutes before MicroVM suspend:",
      {
        defaultValue: String(workingConfig.defaults.idle.suspendAfterMin),
        validate: (v) =>
          !Number.isNaN(Number(v)) && Number(v) >= 0 ? true : "Enter a non-negative number",
      },
    );

    const maxConcurrentStr = await prompter.input("Maximum concurrent cloud agent runs:", {
      defaultValue: String(workingConfig.defaults.maxConcurrent),
      validate: (v) =>
        !Number.isNaN(Number(v)) && Number(v) >= 1 ? true : "Enter a positive number",
    });

    // Step 5: Construct Final Config & Confirm
    workingConfig = {
      ...workingConfig,
      aws: {
        profile: selectedProfile === "default" ? undefined : selectedProfile,
        region: selectedRegion,
      },
      providers: {
        synced: syncedProviders,
        oauthOptIn: oauthOptInList,
        bedrockRole: enableBedrock,
      },
      github: {
        mode: githubMode,
        secretName: githubSecretName,
      },
      defaults: {
        ...workingConfig.defaults,
        maxDurationHours: Number(maxDurationStr),
        idle: {
          ...workingConfig.defaults.idle,
          suspendAfterMin: Number(idleSuspendStr),
        },
        maxConcurrent: Number(maxConcurrentStr),
      },
    };

    const finalPlanText = formatSetupPlanTable(workingConfig, verifiedIdentity);
    prompter.note(finalPlanText, "Setup Plan Confirmation");

    const confirmed = await prompter.confirm("Apply configuration and proceed with setup?", true);
    if (!confirmed) {
      return {
        success: false,
        cancelled: true,
        config: workingConfig,
        planText: finalPlanText,
        dryRun: Boolean(options.dryRun),
        stepsToRun: [],
      };
    }
  }

  // Validate entire config against schema
  const validatedConfig = LocalConfigSchema.parse(workingConfig);

  // Write to disk unless dry-run
  if (!options.dryRun) {
    saveLocalConfig(validatedConfig, { customDir: options.piAgentDir });
  }

  const planText = formatSetupPlanTable(validatedConfig, identity);

  return {
    success: true,
    config: validatedConfig,
    planText,
    githubToken: githubTokenValue,
    dryRun: Boolean(options.dryRun),
    stepsToRun: ["deploy_core", "deploy_image", "sync_bundle"],
  };
}
