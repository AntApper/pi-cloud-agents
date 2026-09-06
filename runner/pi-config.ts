/**
 * In-VM Pi configuration assembly and environment preparation.
 * Downloads the non-secret bundle TAR from storage, fetches provider & GitHub credentials
 * from SecretsManager/SecretsProvider, unpacks files into ~/.pi/agent (0700/0600),
 * registers secrets with the runner logger, and generates a clean process environment.
 */

import { assemblePiAgentDir } from "../core/pi-config.js";
import { type LaunchPayload, ProtocolErrorCode } from "../shared/protocol.js";
import type { Logger } from "./logger.js";
import { SecretMissingError, type SecretsProvider } from "./secrets.js";
import type { StorageSink } from "./storage.js";

export const DEFAULT_PI_AGENT_DIR = "/work/.pi-agent";

/** Common provider environment variable prefixes to scrub if unauthorized. */
const SENSITIVE_PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "COHERE_API_KEY",
  "PERPLEXITY_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
];

export interface AssembleInVmPiEnvironmentParams {
  payload: LaunchPayload;
  secretsProvider: SecretsProvider;
  storageSink: StorageSink;
  targetDir?: string;
  logger?: Logger;
}

export interface AssembleInVmPiResult {
  piAgentDir: string;
  env: Record<string, string>;
  assembledFiles: string[];
  syncedProviders: string[];
}

/**
 * Resolves the canonical Secrets Manager secret name for a provider given the stack name.
 */
export function getProviderSecretName(stackName: string, providerId: string): string {
  if (
    providerId.startsWith("pi-cloud-agents/") ||
    providerId.startsWith("arn:aws:secretsmanager:")
  ) {
    return providerId;
  }
  return `pi-cloud-agents/${stackName}/pi-auth/${providerId}`;
}

/**
 * Extracts provider name from a full secret name or returns providerId.
 */
export function getProviderIdFromSecretName(secretName: string): string {
  if (secretName.includes("/pi-auth/")) {
    const parts = secretName.split("/pi-auth/");
    return parts[parts.length - 1] || secretName;
  }
  return secretName;
}

/**
 * Downloads the bundle TAR, retrieves required credentials, assembles the .pi-agent directory,
 * registers secrets with the logger, and prepares the sanitized environment.
 */
export async function assembleInVmPiEnvironment(
  params: AssembleInVmPiEnvironmentParams,
): Promise<AssembleInVmPiResult> {
  const { payload, secretsProvider, storageSink, logger } = params;
  const targetDir = params.targetDir ?? process.env.PI_CODING_AGENT_DIR ?? DEFAULT_PI_AGENT_DIR;

  logger?.info?.(
    `Assembling in-VM pi environment for run '${payload.runId}' in target directory '${targetDir}'`,
  );

  // 1. Download bundle TAR from storage sink
  let bundleTar: Buffer;
  try {
    bundleTar = await storageSink.getObject(payload.piConfig.bundleKey);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger?.error?.(
      `Failed to download pi config bundle '${payload.piConfig.bundleKey}': ${errMsg}`,
    );
    const error = new Error(`Failed to download config bundle from storage: ${errMsg}`);
    (error as { code?: string }).code = ProtocolErrorCode.INTERNAL_ERROR;
    throw error;
  }

  // 2. Fetch provider secrets from SecretsProvider
  const secretsMap = new Map<string, string>();
  const syncedProviders: string[] = [];

  for (const authParam of payload.piConfig.authParams) {
    const secretName = getProviderSecretName(payload.stack.name, authParam);
    const providerId = getProviderIdFromSecretName(authParam);

    try {
      const secretValue = await secretsProvider.get(secretName);
      secretsMap.set(providerId, secretValue);
      syncedProviders.push(providerId);

      // Register secret with logger for redaction
      logger?.registerSecret(secretValue);
    } catch (err) {
      logger?.error?.(`Required secret '${secretName}' for provider '${providerId}' is missing`);
      if (err instanceof SecretMissingError) {
        throw err;
      }
      const missingError = new SecretMissingError(
        secretName,
        `Required secret for provider '${providerId}' (${secretName}) could not be retrieved: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw missingError;
    }
  }

  // 3. Handle GitHub authentication secret if configured
  let githubToken: string | undefined;
  if (payload.github.mode === "secret") {
    try {
      githubToken = await secretsProvider.get(payload.github.name);
      logger?.registerSecret(githubToken);
    } catch (err) {
      logger?.error?.(`GitHub secret '${payload.github.name}' could not be retrieved`);
      if (err instanceof SecretMissingError) {
        throw err;
      }
      throw new SecretMissingError(
        payload.github.name,
        `GitHub authentication secret '${payload.github.name}' could not be retrieved: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 4. Assemble the ~/.pi/agent directory (extract bundle tar + write auth.json with 0600 mode)
  let assembledFiles: string[];
  try {
    assembledFiles = assemblePiAgentDir(bundleTar, secretsMap, targetDir);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger?.error?.(`Failed to assemble pi agent directory at '${targetDir}': ${errMsg}`);
    throw err;
  }

  // 5. Construct sanitized environment map for the in-VM pi process
  const env: Record<string, string> = {
    // Direct pi process to the isolated agent directory
    PI_CODING_AGENT_DIR: targetDir,
    // AWS Region for Bedrock ambient credentials
    AWS_REGION: payload.stack.region,
  };

  // Build redaction map for In-VM redaction extension (T5.1)
  const redactMap: Record<string, string> = {};

  // Attach GitHub token if configured
  if (githubToken) {
    const trimmedToken = githubToken.trim();
    env.GITHUB_TOKEN = trimmedToken;
    env.GH_TOKEN = trimmedToken;
    redactMap.GITHUB_TOKEN = trimmedToken;
  }

  for (const [providerId, secretVal] of secretsMap.entries()) {
    if (secretVal && secretVal.trim().length >= 4) {
      redactMap[`${providerId.toUpperCase()}_API_KEY`] = secretVal.trim();
    }
  }

  env.PI_CLOUD_REDACT_ENV = JSON.stringify(redactMap);

  // Scrub any unauthorized provider API keys from ambient process environment
  for (const envKey of SENSITIVE_PROVIDER_ENV_KEYS) {
    if (
      envKey in env &&
      !syncedProviders.some((p) => envKey.toLowerCase().includes(p.toLowerCase()))
    ) {
      delete env[envKey];
    }
  }

  logger?.info?.(
    `Successfully assembled pi environment with ${assembledFiles.length} files and ${syncedProviders.length} providers`,
  );

  return {
    piAgentDir: targetDir,
    env,
    assembledFiles,
    syncedProviders,
  };
}
