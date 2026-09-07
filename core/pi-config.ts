/**
 * pi config bundle builder and in-VM guest directory assembler.
 * Pure TypeScript module with zero runtime dependencies on @earendil-works/pi-coding-agent.
 */

import fs from "node:fs";
import path from "node:path";
import type { LocalConfig } from "../shared/config.js";
import { SECRETS_MANAGER_MAX_BYTES, type StoredCredential } from "./credentials.js";

/** Warning threshold for a single secret value (16 KB). */
export const SECRETS_MANAGER_WARN_BYTES = 16384;

/** Fixed epoch for deterministic tar headers (2026-01-01T00:00:00.000Z). */
export const DETERMINISTIC_MTIME = new Date("2026-01-01T00:00:00.000Z");

/**
 * Whitelist of settings keys that are safe to mirror into the MicroVM environment.
 * Keys referencing local paths, local extensions, or local packages are strictly stripped.
 */
export const ALLOWED_SETTINGS_KEYS = new Set([
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "compaction",
  "retry",
  "thinkingBudgets",
]);

/**
 * Entry to be archived in a TAR archive.
 */
export interface TarEntry {
  name: string;
  content: string | Uint8Array;
  mode?: number;
  mtime?: Date;
}

/**
 * Generates a deterministic USTAR TAR archive.
 * Entries are sorted by name, fixed mtimes (2026-01-01) and standard POSIX headers are applied.
 */
export function createDeterministicTar(
  entries: TarEntry[],
  options?: { defaultMtime?: Date },
): Buffer {
  const defaultMtime = options?.defaultMtime ?? DETERMINISTIC_MTIME;
  const mtimeSeconds = Math.floor(defaultMtime.getTime() / 1000);

  // Sort entries alphabetically by file path for reproducible hashing
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const blocks: Buffer[] = [];

  for (const entry of sorted) {
    const rawContent =
      typeof entry.content === "string"
        ? Buffer.from(entry.content, "utf8")
        : Buffer.from(entry.content);

    const size = rawContent.length;
    const mode = entry.mode ?? 0o644;

    const header = Buffer.alloc(512, 0);

    // 0..99: File name
    header.write(entry.name, 0, 100, "utf8");

    // 100..107: File mode (octal, 6 digits + null + space)
    header.write(`${mode.toString(8).padStart(6, "0")} \0`, 100, 8, "ascii");

    // 108..115: UID (octal)
    header.write("0000000\0", 108, 8, "ascii");

    // 116..123: GID (octal)
    header.write("0000000\0", 116, 8, "ascii");

    // 124..135: Size in bytes (octal, 11 digits + space)
    header.write(`${size.toString(8).padStart(11, "0")} `, 124, 12, "ascii");

    // 136..147: Modification time (octal, 11 digits + space)
    header.write(`${mtimeSeconds.toString(8).padStart(11, "0")} `, 136, 12, "ascii");

    // 148..155: Checksum placeholder (8 spaces during calculation)
    header.fill(0x20, 148, 156);

    // 156: Type flag ('0' for regular file)
    header.write("0", 156, 1, "ascii");

    // 257..264: Magic and version ("ustar\0" and "00")
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");

    // 265..296: User name
    header.write("root\0", 265, 5, "ascii");

    // 297..328: Group name
    header.write("root\0", 297, 5, "ascii");

    // Compute checksum of the 512-byte header with spaces at 148..155
    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += header[i]!;
    }

    // Write computed checksum (6 octal digits + null + space)
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");

    blocks.push(header);
    blocks.push(rawContent);

    // Pad content to 512-byte block boundary
    const padding = (512 - (size % 512)) % 512;
    if (padding > 0) {
      blocks.push(Buffer.alloc(padding, 0));
    }
  }

  // End of archive marker: two 512-byte zero blocks (1024 bytes)
  blocks.push(Buffer.alloc(1024, 0));

  return Buffer.concat(blocks);
}

/**
 * Extracts a TAR archive into a destination directory.
 */
export function extractTar(tarBuffer: Buffer, targetDir: string): string[] {
  fs.mkdirSync(targetDir, { recursive: true });
  const extractedFiles: string[] = [];
  let offset = 0;

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);

    // Check for empty end-of-archive block (all zeros)
    let isZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        isZero = false;
        break;
      }
    }

    if (isZero) {
      break;
    }

    // Extract filename
    let nameEnd = 0;
    while (nameEnd < 100 && header[nameEnd] !== 0) {
      nameEnd++;
    }
    const filename = header.subarray(0, nameEnd).toString("utf8");

    // Extract size
    const sizeStr = header.subarray(124, 136).toString("ascii").trim().replace(/\0/g, "");
    const size = Number.parseInt(sizeStr, 8) || 0;

    // Extract mode
    const modeStr = header.subarray(100, 108).toString("ascii").trim().replace(/\0/g, "");
    const mode = Number.parseInt(modeStr, 8) || 0o644;

    // Typeflag
    const typeFlag = String.fromCharCode(header[156] || 0x30);

    offset += 512;

    if (filename) {
      const destPath = path.join(targetDir, filename);
      const resolvedTarget = path.resolve(targetDir);
      const resolvedDest = path.resolve(destPath);

      if (resolvedDest !== resolvedTarget && !resolvedDest.startsWith(resolvedTarget + path.sep)) {
        throw new Error(
          `Security violation: Directory traversal detected in TAR entry '${filename}' resolving to '${resolvedDest}' outside target '${resolvedTarget}'`,
        );
      }

      if (typeFlag === "5" || filename.endsWith("/")) {
        fs.mkdirSync(destPath, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const content = tarBuffer.subarray(offset, offset + size);
        fs.writeFileSync(destPath, content, { mode });
        extractedFiles.push(destPath);
      }
    }

    // Skip payload plus block padding
    const padding = (512 - (size % 512)) % 512;
    offset += size + padding;
  }

  return extractedFiles;
}

/**
 * Filter and sanitize settings object against the allowed settings whitelist.
 */
export function sanitizeSettings(settings?: Record<string, unknown>): Record<string, unknown> {
  if (!settings || typeof settings !== "object") {
    return {};
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (ALLOWED_SETTINGS_KEYS.has(key)) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Parameters for building a pi config bundle.
 */
export interface BuildBundleParams {
  authEntries: Map<string, StoredCredential | unknown> | Record<string, StoredCredential | unknown>;
  modelsJson?: string | Record<string, unknown>;
  settingsSubset?: Record<string, unknown>;
  agentsMd?: string;
  skills?: Record<string, string>;
  localConfig?: LocalConfig;
  stackName?: string;
}

/**
 * Bundle manifest describing contents, providers, and warnings.
 */
export interface BundleManifest {
  v: 1;
  createdAt: string;
  providers: string[];
  files: string[];
  sizeBytes: number;
  warnings?: string[];
}

/**
 * Result of building a pi config bundle.
 */
export interface BuildBundleResult {
  secrets: Map<string, string>;
  bundleTar: Buffer;
  manifest: BundleManifest;
}

/**
 * Determines whether a provider credential should be synced into the remote runner.
 * API key credentials and non-rotating OAuth (Copilot, OpenRouter) are synced by default.
 * Rotating OAuth credentials (Anthropic, OpenAI Codex, xAI, etc.) require explicit opt-in.
 */
export function shouldSyncProvider(
  providerId: string,
  credential: unknown,
  options?: {
    oauthOptIn?: string[];
    syncedProviders?: string[];
  },
): boolean {
  const syncedList = options?.syncedProviders ?? [];
  const oauthOptIn = options?.oauthOptIn ?? [];

  // If explicit synced list is provided, must be included
  if (syncedList.length > 0 && !syncedList.includes(providerId)) {
    return false;
  }

  const isOAuth =
    typeof credential === "object" &&
    credential !== null &&
    (credential as { type?: string }).type === "oauth";

  if (isOAuth) {
    // GitHub Copilot and OpenRouter OAuth do not suffer from refresh token invalidation
    if (providerId === "github-copilot" || providerId === "openrouter") {
      return true;
    }
    // Rotating OAuth providers require explicit opt-in
    return oauthOptIn.includes(providerId);
  }

  return true;
}

/**
 * Builds a deterministic pi config bundle archive and secret map.
 * Secrets are strictly isolated into the secrets map and guaranteed absent from the bundle TAR.
 */
export function buildBundle(params: BuildBundleParams): BuildBundleResult {
  const authMap: Map<string, unknown> =
    params.authEntries instanceof Map
      ? params.authEntries
      : new Map(Object.entries(params.authEntries || {}));

  const oauthOptIn = params.localConfig?.providers?.oauthOptIn ?? [];
  const syncedList = params.localConfig?.providers?.synced ?? [];

  const secrets = new Map<string, string>();
  const syncedProviders: string[] = [];
  const warnings: string[] = [];
  const secretValuesToScan: string[] = [];

  // 1. Process and filter provider credentials
  for (const [providerId, cred] of authMap.entries()) {
    if (!shouldSyncProvider(providerId, cred, { oauthOptIn, syncedProviders: syncedList })) {
      continue;
    }

    const serialized = JSON.stringify(cred);
    const sizeBytes = Buffer.byteLength(serialized, "utf8");

    if (sizeBytes > SECRETS_MANAGER_MAX_BYTES) {
      throw new Error(
        `Secret for provider '${providerId}' (${sizeBytes} bytes) exceeds AWS Secrets Manager 64 KB limit (${SECRETS_MANAGER_MAX_BYTES} bytes)`,
      );
    }

    if (sizeBytes > SECRETS_MANAGER_WARN_BYTES) {
      warnings.push(
        `Secret for provider '${providerId}' is large (${sizeBytes} bytes). Recommended size is under 16 KB.`,
      );
    }

    secrets.set(providerId, serialized);
    syncedProviders.push(providerId);

    // Collect secret substrings for negative leak assertion
    if (typeof cred === "object" && cred !== null) {
      const obj = cred as Record<string, unknown>;
      if (typeof obj.key === "string" && obj.key.length >= 6) {
        secretValuesToScan.push(obj.key);
      }
      if (typeof obj.refresh === "string" && obj.refresh.length >= 6) {
        secretValuesToScan.push(obj.refresh);
      }
      if (typeof obj.access === "string" && obj.access.length >= 6) {
        secretValuesToScan.push(obj.access);
      }
    }
  }

  // 2. Build non-secret config files for bundle tar
  const tarEntries: TarEntry[] = [];
  const filesList: string[] = [];

  // models.json
  if (params.modelsJson) {
    const modelsContent =
      typeof params.modelsJson === "string"
        ? params.modelsJson
        : JSON.stringify(params.modelsJson, null, 2);
    tarEntries.push({
      name: "models.json",
      content: `${modelsContent.trim()}\n`,
    });
    filesList.push("models.json");
  }

  // settings.json (sanitized allow-list only)
  const sanitizedSettings = sanitizeSettings(params.settingsSubset);
  if (Object.keys(sanitizedSettings).length > 0) {
    tarEntries.push({
      name: "settings.json",
      content: `${JSON.stringify(sanitizedSettings, null, 2)}\n`,
    });
    filesList.push("settings.json");
  }

  // AGENTS.md
  if (params.agentsMd) {
    tarEntries.push({
      name: "AGENTS.md",
      content: params.agentsMd.endsWith("\n") ? params.agentsMd : `${params.agentsMd}\n`,
    });
    filesList.push("AGENTS.md");
  }

  // Skills
  if (params.skills) {
    for (const [skillPath, skillContent] of Object.entries(params.skills)) {
      const relPath = skillPath.startsWith("skills/") ? skillPath : `skills/${skillPath}`;
      tarEntries.push({
        name: relPath,
        content: skillContent.endsWith("\n") ? skillContent : `${skillContent}\n`,
      });
      filesList.push(relPath);
    }
  }

  // 3. Create deterministic TAR buffer
  const bundleTar = createDeterministicTar(tarEntries);

  // 4. Critical Security Assertion: Verify zero secrets exist in the TAR archive
  const tarString = bundleTar.toString("utf8");
  for (const secretVal of secretValuesToScan) {
    if (tarString.includes(secretVal)) {
      throw new Error(
        "Security violation: Secret credential token detected inside config bundle archive",
      );
    }
  }

  if (tarString.includes("auth.json")) {
    throw new Error(
      "Security violation: auth.json file detected inside non-secret config bundle archive",
    );
  }

  const manifest: BundleManifest = {
    v: 1,
    createdAt: new Date().toISOString(),
    providers: syncedProviders,
    files: filesList,
    sizeBytes: bundleTar.length,
    warnings: warnings.length > 0 ? warnings : undefined,
  };

  return {
    secrets,
    bundleTar,
    manifest,
  };
}

/**
 * Assembles the full ~/.pi/agent directory inside the MicroVM runner.
 * Extracts the non-secret bundle TAR and constructs auth.json with mode 0600 from secrets.
 */
export function assemblePiAgentDir(
  bundleTar: Buffer,
  secrets: Map<string, string> | Record<string, string>,
  targetDir: string,
): string[] {
  // 1. Ensure target directory exists with strict 0700 permissions
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(targetDir, 0o700);

  // 2. Extract non-secret bundle TAR into targetDir
  const extractedFiles = extractTar(bundleTar, targetDir);

  // 3. Assemble auth.json with strict 0600 permissions
  const secretEntries =
    secrets instanceof Map ? Array.from(secrets.entries()) : Object.entries(secrets || {});

  const authJson: Record<string, unknown> = {};
  for (const [providerId, secretVal] of secretEntries) {
    try {
      authJson[providerId] = typeof secretVal === "string" ? JSON.parse(secretVal) : secretVal;
    } catch {
      authJson[providerId] = secretVal;
    }
  }

  const authPath = path.join(targetDir, "auth.json");
  const authSerialized = `${JSON.stringify(authJson, null, 2)}\n`;

  fs.writeFileSync(authPath, authSerialized, { mode: 0o600, encoding: "utf8" });
  fs.chmodSync(authPath, 0o600);

  extractedFiles.push(authPath);
  return extractedFiles;
}
