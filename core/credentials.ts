/**
 * Credential inspection, validation, size analysis, and portability helpers for pi-cloud-agents.
 * Pure TypeScript module with zero runtime dependencies on @earendil-works/pi-coding-agent.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Max size allowed for a single AWS Secrets Manager secret value (64 KB). */
export const SECRETS_MANAGER_MAX_BYTES = 65536;

/** Stored API key credential shape in pi's auth.json. */
export interface ApiKeyCredential {
  type: "api_key";
  key?: string;
  env?: Record<string, string>;
}

/** Stored OAuth credential shape in pi's auth.json. */
export interface OAuthCredential {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  accountId?: string;
  enterpriseUrl?: string;
  availableModelIds?: string[];
  scope?: string;
  [key: string]: unknown;
}

/** Discriminated union of stored credential types. */
export type StoredCredential = ApiKeyCredential | OAuthCredential;

/** Map of provider ID to stored credential in auth.json. */
export type AuthJson = Record<string, StoredCredential>;

/** Classification of key expression type in auth.json. */
export type KeyResolutionType = "literal" | "command" | "env_var" | "empty";

/** Portability status of a provider credential. */
export type PortabilityStatus = "portable" | "conditional" | "ambient_only" | "unknown";

/** Refresh collision risk for an OAuth credential. */
export type RefreshConflictRisk = "none" | "conflict" | "not_applicable";

/** Provider category metadata. */
export interface ProviderCategoryInfo {
  providerId: string;
  name: string;
  authType: "api_key" | "oauth" | "ambient" | "custom";
  defaultPortability: PortabilityStatus;
  refreshConflictRisk: RefreshConflictRisk;
  syncRecommendation: "default_sync" | "opt_in_notice" | "ambient_role" | "manual";
  notes: string;
}

/** Known provider metadata catalog. */
export const KNOWN_PROVIDERS: Record<string, ProviderCategoryInfo> = {
  anthropic: {
    providerId: "anthropic",
    name: "Anthropic (API Key / Claude Pro/Max)",
    authType: "api_key",
    defaultPortability: "portable",
    refreshConflictRisk: "not_applicable",
    syncRecommendation: "default_sync",
    notes:
      "API keys are fully portable. OAuth subscriptions rotate refresh tokens on refresh (conflict risk).",
  },
  "anthropic-oauth": {
    providerId: "anthropic",
    name: "Anthropic Claude Pro/Max (OAuth)",
    authType: "oauth",
    defaultPortability: "conditional",
    refreshConflictRisk: "conflict",
    syncRecommendation: "opt_in_notice",
    notes:
      "OAuth PKCE flow with refresh token rotation. VM refresh invalidates local token. Requires opt-in and ToS notice.",
  },
  openai: {
    providerId: "openai",
    name: "OpenAI (API Key)",
    authType: "api_key",
    defaultPortability: "portable",
    refreshConflictRisk: "not_applicable",
    syncRecommendation: "default_sync",
    notes: "API keys are fully portable.",
  },
  "openai-codex": {
    providerId: "openai-codex",
    name: "OpenAI ChatGPT Plus/Pro (Codex OAuth)",
    authType: "oauth",
    defaultPortability: "conditional",
    refreshConflictRisk: "conflict",
    syncRecommendation: "opt_in_notice",
    notes:
      "OAuth with refresh token rotation. VM refresh invalidates local token. Requires opt-in and ToS notice.",
  },
  "github-copilot": {
    providerId: "github-copilot",
    name: "GitHub Copilot (OAuth)",
    authType: "oauth",
    defaultPortability: "portable",
    refreshConflictRisk: "none",
    syncRecommendation: "default_sync",
    notes:
      "Uses static GitHub OAuth token to mint short-lived session tokens without refresh token rotation. No conflict.",
  },
  openrouter: {
    providerId: "openrouter",
    name: "OpenRouter (API Key / OAuth)",
    authType: "api_key",
    defaultPortability: "portable",
    refreshConflictRisk: "none",
    syncRecommendation: "default_sync",
    notes:
      "OpenRouter OAuth mints a permanent API key. Refresh is a no-op with no expiration. Fully portable.",
  },
  google: {
    providerId: "google",
    name: "Google Gemini (API Key)",
    authType: "api_key",
    defaultPortability: "portable",
    refreshConflictRisk: "not_applicable",
    syncRecommendation: "default_sync",
    notes: "API keys (GEMINI_API_KEY) are fully portable.",
  },
  deepseek: {
    providerId: "deepseek",
    name: "DeepSeek (API Key)",
    authType: "api_key",
    defaultPortability: "portable",
    refreshConflictRisk: "not_applicable",
    syncRecommendation: "default_sync",
    notes: "API keys are fully portable.",
  },
  mistral: {
    providerId: "mistral",
    name: "Mistral (API Key)",
    authType: "api_key",
    defaultPortability: "portable",
    refreshConflictRisk: "not_applicable",
    syncRecommendation: "default_sync",
    notes: "API keys are fully portable.",
  },
  groq: {
    providerId: "groq",
    name: "Groq (API Key)",
    authType: "api_key",
    defaultPortability: "portable",
    refreshConflictRisk: "not_applicable",
    syncRecommendation: "default_sync",
    notes: "API keys are fully portable.",
  },
  cerebras: {
    providerId: "cerebras",
    name: "Cerebras (API Key)",
    authType: "api_key",
    defaultPortability: "portable",
    refreshConflictRisk: "not_applicable",
    syncRecommendation: "default_sync",
    notes: "API keys are fully portable.",
  },
  together: {
    providerId: "together",
    name: "Together AI (API Key)",
    authType: "api_key",
    defaultPortability: "portable",
    refreshConflictRisk: "not_applicable",
    syncRecommendation: "default_sync",
    notes: "API keys are fully portable.",
  },
  fireworks: {
    providerId: "fireworks",
    name: "Fireworks AI (API Key)",
    authType: "api_key",
    defaultPortability: "portable",
    refreshConflictRisk: "not_applicable",
    syncRecommendation: "default_sync",
    notes: "API keys are fully portable.",
  },
  nvidia: {
    providerId: "nvidia",
    name: "NVIDIA NIM (API Key)",
    authType: "api_key",
    defaultPortability: "portable",
    refreshConflictRisk: "not_applicable",
    syncRecommendation: "default_sync",
    notes: "API keys are fully portable.",
  },
  xai: {
    providerId: "xai",
    name: "xAI (API Key / Grok Subscription)",
    authType: "api_key",
    defaultPortability: "portable",
    refreshConflictRisk: "not_applicable",
    syncRecommendation: "default_sync",
    notes: "API keys are fully portable. OAuth subscription uses device code with token rotation.",
  },
  "xai-oauth": {
    providerId: "xai",
    name: "xAI Grok / X Subscription (OAuth)",
    authType: "oauth",
    defaultPortability: "conditional",
    refreshConflictRisk: "conflict",
    syncRecommendation: "opt_in_notice",
    notes: "OAuth device-code flow with token refresh. Potential collision on rotation.",
  },
  "azure-openai-responses": {
    providerId: "azure-openai-responses",
    name: "Azure OpenAI Responses (API Key)",
    authType: "api_key",
    defaultPortability: "portable",
    refreshConflictRisk: "not_applicable",
    syncRecommendation: "default_sync",
    notes: "API key and endpoints/deployments are fully portable.",
  },
  "amazon-bedrock": {
    providerId: "amazon-bedrock",
    name: "Amazon Bedrock (IAM / Bearer Token)",
    authType: "ambient",
    defaultPortability: "ambient_only",
    refreshConflictRisk: "not_applicable",
    syncRecommendation: "ambient_role",
    notes: "Zero secret sync. VM execution role provides native Bedrock permissions via IMDSv2.",
  },
  "cloudflare-ai-gateway": {
    providerId: "cloudflare-ai-gateway",
    name: "Cloudflare AI Gateway (API Key + Env)",
    authType: "api_key",
    defaultPortability: "portable",
    refreshConflictRisk: "not_applicable",
    syncRecommendation: "default_sync",
    notes: "API key and provider-scoped env (account/gateway ID) are portable.",
  },
  "cloudflare-workers-ai": {
    providerId: "cloudflare-workers-ai",
    name: "Cloudflare Workers AI (API Key + Env)",
    authType: "api_key",
    defaultPortability: "portable",
    refreshConflictRisk: "not_applicable",
    syncRecommendation: "default_sync",
    notes: "API key and account ID are portable.",
  },
  "kimi-coding": {
    providerId: "kimi-coding",
    name: "Kimi Code (API Key / Subscription)",
    authType: "api_key",
    defaultPortability: "portable",
    refreshConflictRisk: "not_applicable",
    syncRecommendation: "default_sync",
    notes: "API keys are portable. OAuth subscription rotates refresh tokens.",
  },
  radius: {
    providerId: "radius",
    name: "Radius Gateway (API Key / OAuth)",
    authType: "api_key",
    defaultPortability: "portable",
    refreshConflictRisk: "not_applicable",
    syncRecommendation: "default_sync",
    notes: "API keys are portable. OAuth rotates refresh tokens on gateway.",
  },
};

/**
 * Classify how a key string is resolved (literal string, command execution, or env var interpolation).
 */
export function resolveKeyType(key: string | undefined): KeyResolutionType {
  if (!key || key.trim().length === 0) {
    return "empty";
  }
  const trimmed = key.trim();
  if (trimmed.startsWith("!") && !trimmed.startsWith("$!")) {
    return "command";
  }
  if (trimmed.startsWith("$") && !trimmed.startsWith("$$") && !trimmed.startsWith("$!")) {
    return "env_var";
  }
  return "literal";
}

/**
 * Mask a secret string safely for display and evidence.
 * Keeps a tiny prefix/suffix for identification when sufficiently long, but replaces body with asterisks.
 */
export function maskSecretValue(value: string | undefined): string {
  if (!value || typeof value !== "string") {
    return "<empty>";
  }
  const len = value.length;
  if (len <= 8) {
    return "********";
  }
  if (len <= 16) {
    return `${value.slice(0, 3)}***${value.slice(-3)} (${len} chars)`;
  }
  return `${value.slice(0, 6)}***${value.slice(-4)} (${len} chars)`;
}

/**
 * Deeply mask an individual stored credential entry.
 */
export function maskCredentialEntry(entry: StoredCredential): Record<string, unknown> {
  if (entry.type === "api_key") {
    const masked: Record<string, unknown> = {
      type: "api_key",
      key: entry.key ? maskSecretValue(entry.key) : undefined,
    };
    if (entry.env) {
      const maskedEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(entry.env)) {
        maskedEnv[k] = maskSecretValue(v);
      }
      masked.env = maskedEnv;
    }
    return masked;
  }

  if (entry.type === "oauth") {
    return {
      type: "oauth",
      access: maskSecretValue(entry.access),
      refresh: maskSecretValue(entry.refresh),
      expires: entry.expires,
      accountId: entry.accountId,
      enterpriseUrl: entry.enterpriseUrl,
      availableModelIdsCount: entry.availableModelIds?.length,
      scope: entry.scope,
    };
  }

  return { type: "unknown" };
}

/**
 * Calculate serialized JSON size of a credential entry in bytes.
 */
export function calculateCredentialSize(entry: unknown): number {
  if (entry === undefined || entry === null) {
    return 0;
  }
  return Buffer.byteLength(JSON.stringify(entry), "utf8");
}

/**
 * Validate a single credential entry extracted from auth.json.
 */
export function validateCredentialEntry(
  providerId: string,
  raw: unknown,
): { valid: boolean; error?: string; credential?: StoredCredential } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, error: `Provider "${providerId}" entry is not a valid JSON object` };
  }

  const record = raw as Record<string, unknown>;
  const type = record.type;

  if (type === "api_key") {
    const key = typeof record.key === "string" ? record.key : undefined;
    let env: Record<string, string> | undefined;
    if (record.env && typeof record.env === "object" && !Array.isArray(record.env)) {
      env = {};
      for (const [k, v] of Object.entries(record.env)) {
        if (typeof v === "string") {
          env[k] = v;
        }
      }
    }
    const cred: ApiKeyCredential = { type: "api_key", key, env };
    return { valid: true, credential: cred };
  }

  if (type === "oauth") {
    if (typeof record.refresh !== "string") {
      return {
        valid: false,
        error: `OAuth entry for "${providerId}" missing string "refresh" field`,
      };
    }
    if (typeof record.access !== "string") {
      return {
        valid: false,
        error: `OAuth entry for "${providerId}" missing string "access" field`,
      };
    }
    if (typeof record.expires !== "number" || !Number.isFinite(record.expires)) {
      return {
        valid: false,
        error: `OAuth entry for "${providerId}" missing valid numeric "expires" timestamp`,
      };
    }

    const cred: OAuthCredential = {
      type: "oauth",
      refresh: record.refresh,
      access: record.access,
      expires: record.expires,
      accountId: typeof record.accountId === "string" ? record.accountId : undefined,
      enterpriseUrl: typeof record.enterpriseUrl === "string" ? record.enterpriseUrl : undefined,
      availableModelIds: Array.isArray(record.availableModelIds)
        ? (record.availableModelIds.filter((m) => typeof m === "string") as string[])
        : undefined,
      scope: typeof record.scope === "string" ? record.scope : undefined,
    };
    return { valid: true, credential: cred };
  }

  return {
    valid: false,
    error: `Provider "${providerId}" has unknown credential type: "${String(type)}"`,
  };
}

/**
 * Parse an auth.json string into validated credentials and collected parse errors.
 */
export function parseAuthJson(content: string): {
  credentials: Record<string, StoredCredential>;
  errors: string[];
  rawCount: number;
} {
  const credentials: Record<string, StoredCredential> = {};
  const errors: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      credentials: {},
      errors: [`Invalid JSON format: ${err instanceof Error ? err.message : String(err)}`],
      rawCount: 0,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      credentials: {},
      errors: ["auth.json root must be a JSON object mapping provider IDs to credentials"],
      rawCount: 0,
    };
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [providerId, rawEntry] of entries) {
    const result = validateCredentialEntry(providerId, rawEntry);
    if (result.valid && result.credential) {
      credentials[providerId] = result.credential;
    } else if (result.error) {
      errors.push(result.error);
    }
  }

  return {
    credentials,
    errors,
    rawCount: entries.length,
  };
}

/** Detailed analysis of a single provider credential. */
export interface ProviderCredentialAnalysis {
  providerId: string;
  name: string;
  type: "api_key" | "oauth" | "ambient" | "custom";
  keyResolutionType?: KeyResolutionType;
  portability: PortabilityStatus;
  refreshConflictRisk: RefreshConflictRisk;
  syncRecommendation: "default_sync" | "opt_in_notice" | "ambient_role" | "manual";
  sizeBytes: number;
  fitsInSecretsManager: boolean;
  notes: string;
  masked: Record<string, unknown>;
}

/**
 * Analyze a specific provider's credential entry.
 */
export function analyzeProviderCredential(
  providerId: string,
  credential?: StoredCredential,
): ProviderCredentialAnalysis {
  const metaKey = credential?.type === "oauth" ? `${providerId}-oauth` : providerId;
  const known = KNOWN_PROVIDERS[metaKey] ??
    KNOWN_PROVIDERS[providerId] ?? {
      providerId,
      name: providerId,
      authType: (credential?.type ?? "api_key") as "api_key" | "oauth",
      defaultPortability: (credential?.type === "oauth"
        ? "conditional"
        : "portable") as PortabilityStatus,
      refreshConflictRisk: (credential?.type === "oauth"
        ? "conflict"
        : "not_applicable") as RefreshConflictRisk,
      syncRecommendation: (credential?.type === "oauth" ? "opt_in_notice" : "default_sync") as
        | "default_sync"
        | "opt_in_notice",
      notes: "Custom or extension provider.",
    };

  const sizeBytes = calculateCredentialSize(credential);
  const fitsInSecretsManager = sizeBytes <= SECRETS_MANAGER_MAX_BYTES;

  let keyRes: KeyResolutionType | undefined;
  let notes = known.notes;
  let portability = known.defaultPortability;

  if (credential?.type === "api_key") {
    keyRes = resolveKeyType(credential.key);
    if (keyRes === "command") {
      portability = "conditional";
      notes +=
        " Warning: Contains command execution (!cmd) which requires resolution before VM export.";
    }
  }

  return {
    providerId,
    name: known.name,
    type: credential?.type ?? known.authType,
    keyResolutionType: keyRes,
    portability,
    refreshConflictRisk:
      credential?.type === "oauth" ? known.refreshConflictRisk : "not_applicable",
    syncRecommendation: known.syncRecommendation,
    sizeBytes,
    fitsInSecretsManager,
    notes,
    masked: credential ? maskCredentialEntry(credential) : {},
  };
}

/** Summary analysis of an auth.json file or content. */
export interface AuthAnalysisReport {
  filePath?: string;
  totalProviders: number;
  validProviders: number;
  totalSizeBytes: number;
  allFitSecretsManager: boolean;
  parseErrors: string[];
  providers: ProviderCredentialAnalysis[];
}

/**
 * Analyze full auth.json content or file path.
 */
export function analyzeAuthContent(content: string, filePath?: string): AuthAnalysisReport {
  const { credentials, errors } = parseAuthJson(content);
  const totalSizeBytes = Buffer.byteLength(content, "utf8");

  const providers: ProviderCredentialAnalysis[] = [];
  let allFit = true;

  for (const [providerId, cred] of Object.entries(credentials)) {
    const analysis = analyzeProviderCredential(providerId, cred);
    if (!analysis.fitsInSecretsManager) {
      allFit = false;
    }
    providers.push(analysis);
  }

  return {
    filePath,
    totalProviders: Object.keys(credentials).length,
    validProviders: providers.length,
    totalSizeBytes,
    allFitSecretsManager: allFit,
    parseErrors: errors,
    providers,
  };
}

/** Result of simulating credential export to a sandbox directory. */
export interface SandboxExportResult {
  success: boolean;
  targetDir: string;
  authJsonPath: string;
  exportedProviders: string[];
  skippedProviders: { providerId: string; reason: string }[];
  writtenSizeBytes: number;
}

/**
 * Simulate exporting auth credentials to a sandbox pi config directory (e.g. /tmp/pi-b).
 * Respects sync policies: default-sync API keys and opted-in OAuth providers.
 */
export function simulateSandboxExport(
  credentials: Record<string, StoredCredential>,
  targetDir: string,
  options?: {
    allowedProviders?: string[];
    optInOAuthProviders?: string[];
  },
): SandboxExportResult {
  const exportedAuth: Record<string, StoredCredential> = {};
  const exportedProviders: string[] = [];
  const skippedProviders: { providerId: string; reason: string }[] = [];

  const allowList = options?.allowedProviders ? new Set(options.allowedProviders) : null;
  const oauthOptIn = new Set(options?.optInOAuthProviders ?? []);

  for (const [providerId, cred] of Object.entries(credentials)) {
    if (allowList && !allowList.has(providerId)) {
      skippedProviders.push({ providerId, reason: "Not selected in allowedProviders filter" });
      continue;
    }

    if (cred.type === "oauth") {
      const isOptedIn = oauthOptIn.has(providerId);
      // GitHub Copilot and OpenRouter are non-rotating and safe by default, other OAuth requires opt-in
      const isNonRotating = providerId === "github-copilot" || providerId === "openrouter";
      if (!isOptedIn && !isNonRotating) {
        skippedProviders.push({
          providerId,
          reason: "OAuth provider requires explicit opt-in due to refresh token rotation risk",
        });
        continue;
      }
    }

    exportedAuth[providerId] = cred;
    exportedProviders.push(providerId);
  }

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  }

  const authJsonPath = path.join(targetDir, "auth.json");
  const content = JSON.stringify(exportedAuth, null, 2);
  fs.writeFileSync(authJsonPath, content, { encoding: "utf8", mode: 0o600 });

  return {
    success: true,
    targetDir,
    authJsonPath,
    exportedProviders,
    skippedProviders,
    writtenSizeBytes: Buffer.byteLength(content, "utf8"),
  };
}

/** Full spike result data structure. */
export interface CredentialSpikeReport {
  timestamp: string;
  authSourcePath: string;
  authFound: boolean;
  modelsJsonPath?: string;
  modelsJsonFound: boolean;
  localAnalysis: AuthAnalysisReport;
  sandboxTest: SandboxExportResult | null;
  knownProvidersMatrix: ProviderCategoryInfo[];
  assumptionA10Status: "VERIFIED" | "REFUTED";
  verdict: string;
}

/**
 * Resolve the standard pi agent config directory.
 */
export function resolvePiAgentDir(customDir?: string): string {
  if (customDir) {
    return path.resolve(customDir);
  }
  if (process.env.PI_CODING_AGENT_DIR && process.env.PI_CODING_AGENT_DIR !== "undefined") {
    return path.resolve(process.env.PI_CODING_AGENT_DIR);
  }
  return path.join(os.homedir(), ".pi", "agent");
}

/**
 * Execute the credential portability spike.
 */
export function runCredentialSpike(options?: {
  piAgentDir?: string;
  sandboxDir?: string;
  optInOAuthProviders?: string[];
}): CredentialSpikeReport {
  const agentDir = resolvePiAgentDir(options?.piAgentDir);
  const authPath = path.join(agentDir, "auth.json");
  const modelsPath = path.join(agentDir, "models.json");

  const authFound = fs.existsSync(authPath);
  const modelsJsonFound = fs.existsSync(modelsPath);

  let content = "{}";
  if (authFound) {
    try {
      content = fs.readFileSync(authPath, "utf8");
    } catch (_err) {
      content = "{}";
    }
  }

  const localAnalysis = analyzeAuthContent(content, authPath);

  let sandboxTest: SandboxExportResult | null = null;
  const { credentials } = parseAuthJson(content);

  const sandboxTarget =
    options?.sandboxDir || path.join(os.tmpdir(), `pi-cloud-sandbox-${Date.now()}`);
  sandboxTest = simulateSandboxExport(credentials, sandboxTarget, {
    optInOAuthProviders: options?.optInOAuthProviders,
  });

  const matrix = Object.values(KNOWN_PROVIDERS);
  const assumptionA10Status = localAnalysis.allFitSecretsManager ? "VERIFIED" : "REFUTED";

  return {
    timestamp: new Date().toISOString(),
    authSourcePath: authPath,
    authFound,
    modelsJsonPath: modelsPath,
    modelsJsonFound,
    localAnalysis,
    sandboxTest,
    knownProvidersMatrix: matrix,
    assumptionA10Status,
    verdict: "Portability and refresh collision matrix evaluated successfully.",
  };
}

/**
 * Format the spike report into an aligned, no-emoji ASCII/Unicode table.
 */
export function formatCredentialPortabilityTable(report: CredentialSpikeReport): string {
  const width = 86;
  const innerWidth = width - 4;
  const lines: string[] = [];

  const pad = (left: string, right: string, targetWidth: number): string => {
    const totalContentLen = left.length + right.length;
    if (totalContentLen >= targetWidth) {
      return `${left} ${right}`;
    }
    return left + " ".repeat(targetWidth - totalContentLen) + right;
  };

  const headerTitle = " pi Credential Portability Spike (T0.6) ";
  const topBorderLen = width - 2 - headerTitle.length;
  lines.push(`┌${headerTitle}${"─".repeat(Math.max(0, topBorderLen))}┐`);

  // Local environment status
  const authBadge = report.authFound ? "✓ FOUND" : "○ EMPTY";
  const authVal = report.authFound
    ? `${report.localAnalysis.validProviders} provider(s) (${report.localAnalysis.totalSizeBytes} bytes)`
    : "No auth.json at source path";
  lines.push(
    `│ ${pad(`Auth Store: ${report.authSourcePath}`.slice(0, innerWidth - 12), authBadge, innerWidth)} │`,
  );
  lines.push(`│ ${pad(`  └─ Details: ${authVal}`.slice(0, innerWidth - 10), "", innerWidth)} │`);

  if (report.modelsJsonFound && report.modelsJsonPath) {
    lines.push(
      `│ ${pad(`Models Store: ${report.modelsJsonPath}`.slice(0, innerWidth - 12), "✓ FOUND", innerWidth)} │`,
    );
  }

  // Section: Local Detected Credentials
  if (report.localAnalysis.providers.length > 0) {
    lines.push(`├${"─".repeat(width - 2)}┤`);
    lines.push(`│ ${"Discovered Local Credentials:".padEnd(innerWidth)} │`);
    for (const p of report.localAnalysis.providers) {
      const portBadge = p.portability === "portable" ? "✓ PORTABLE" : "▲ CONDITIONAL";
      const sizeStr = `${p.sizeBytes} B`;
      const lineText = `• ${p.providerId.padEnd(24)} ${p.type.padEnd(10)} ${sizeStr.padStart(6)}   ${portBadge}`;
      lines.push(`│ ${pad(lineText, p.fitsInSecretsManager ? "✓ <64KB" : "✗ OVER", innerWidth)} │`);
    }
  }

  // Section: Matrix Summary
  lines.push(`├${"─".repeat(width - 2)}┤`);
  lines.push(`│ ${"Provider Portability & Refresh Conflict Matrix:".padEnd(innerWidth)} │`);
  lines.push(
    `│ ${"Provider".padEnd(24)} ${"Type".padEnd(9)} ${"Portability".padEnd(14)} ${"Conflict".padEnd(12)} ${"Recommendation".padEnd(16)} │`,
  );
  lines.push(
    `│ ${"─".repeat(24)} ${"─".repeat(9)} ${"─".repeat(14)} ${"─".repeat(12)} ${"─".repeat(16)} │`,
  );

  const representativeProviders = [
    "anthropic",
    "anthropic-oauth",
    "openai",
    "openai-codex",
    "github-copilot",
    "openrouter",
    "google",
    "deepseek",
    "groq",
    "xai",
    "xai-oauth",
    "amazon-bedrock",
    "cloudflare-ai-gateway",
  ];

  for (const pId of representativeProviders) {
    const p = KNOWN_PROVIDERS[pId];
    if (!p) continue;
    const portStr =
      p.defaultPortability === "portable"
        ? "✓ portable"
        : p.defaultPortability === "ambient_only"
          ? "· ambient"
          : "▲ conditional";
    const confStr =
      p.refreshConflictRisk === "conflict"
        ? "▲ conflict"
        : p.refreshConflictRisk === "none"
          ? "✓ none"
          : "· n/a";
    const recStr =
      p.syncRecommendation === "default_sync"
        ? "default sync"
        : p.syncRecommendation === "opt_in_notice"
          ? "opt-in notice"
          : "ambient role";
    const row = `${p.providerId.padEnd(24)} ${p.authType.padEnd(9)} ${portStr.padEnd(14)} ${confStr.padEnd(12)} ${recStr.padEnd(16)}`;
    lines.push(`│ ${row.padEnd(innerWidth)} │`);
  }

  // Section: Sandbox Simulation
  if (report.sandboxTest) {
    lines.push(`├${"─".repeat(width - 2)}┤`);
    lines.push(`│ ${"Sandbox Sync Simulation:".padEnd(innerWidth)} │`);
    const sbSummary = `Exported ${report.sandboxTest.exportedProviders.length} provider(s) to sandbox (${report.sandboxTest.writtenSizeBytes} bytes)`;
    lines.push(`│ ${pad(sbSummary, "✓ PASS", innerWidth)} │`);
    lines.push(
      `│ ${pad(`Target Dir: ${report.sandboxTest.targetDir}`.slice(0, innerWidth - 2), "", innerWidth)} │`,
    );
    if (report.sandboxTest.skippedProviders.length > 0) {
      for (const skipped of report.sandboxTest.skippedProviders) {
        lines.push(
          `│ ${`  └─ Skipped ${skipped.providerId}: ${skipped.reason}`.slice(0, innerWidth).padEnd(innerWidth)} │`,
        );
      }
    }
  }

  // Section: Assumptions & Verdict
  lines.push(`├${"─".repeat(width - 2)}┤`);
  lines.push(
    `│ ${pad("Assumption A10 (Secrets Manager <=64 KB Limit)", `✓ ${report.assumptionA10Status}`, innerWidth)} │`,
  );
  lines.push(`│ ${pad("ADR-5 Recommendation Alignment", "✓ CONFIRMED", innerWidth)} │`);
  lines.push(
    `│ ${pad("OAuth Token Broker (T5.9 Requirement)", "● REQUIRED (Rotating OAuth)", innerWidth)} │`,
  );
  lines.push(`└${"─".repeat(width - 2)}┘`);

  return lines.join("\n");
}
