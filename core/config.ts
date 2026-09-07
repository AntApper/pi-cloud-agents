import fs from "node:fs";
import path from "node:path";
import type { ZodError, z } from "zod";
import {
  DEFAULT_LOCAL_CONFIG,
  type LocalConfig,
  LocalConfigSchema,
  type RepoConfig,
  RepoConfigSchema,
} from "../shared/config.js";

/**
 * Custom error class for configuration loading and validation failures.
 */
export class ConfigError extends Error {
  readonly filePath?: string;
  readonly line?: number;
  readonly column?: number;

  constructor(
    message: string,
    options?: { filePath?: string; line?: number; column?: number; cause?: unknown },
  ) {
    super(message);
    this.name = "ConfigError";
    this.filePath = options?.filePath;
    this.line = options?.line;
    this.column = options?.column;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

import { resolvePiAgentDir } from "./credentials.js";
export { resolvePiAgentDir };

/**
 * Checks whether pi-cloud-agents local configuration exists.
 */
export function isConfigured(customDir?: string): boolean {
  return fs.existsSync(getLocalConfigPath(customDir));
}

/**
 * Get path to local configuration file (~/.pi/agent/pi-cloud-agents.json).
 */
export function getLocalConfigPath(customDir?: string): string {
  const agentDir = resolvePiAgentDir(customDir);
  return path.join(agentDir, "pi-cloud-agents.json");
}

/**
 * Get path to repository configuration file (<repo>/.pi/cloud-agents.json).
 */
export function getRepoConfigPath(repoDir?: string): string {
  const targetDir = repoDir ? path.resolve(repoDir) : process.cwd();
  return path.join(targetDir, ".pi", "cloud-agents.json");
}

/**
 * Locate approximate line and column for a JSON syntax error or key path.
 */
function findLineAndColumnFromPosition(
  text: string,
  position: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(position, text.length));
  const lines = text.slice(0, clamped).split("\n");
  const line = lines.length;
  const column = (lines[lines.length - 1]?.length ?? 0) + 1;
  return { line, column };
}

/**
 * Locate approximate line number for a specific JSON object key path in source text.
 */
function findLineForKeyPath(text: string, pathSegments: (string | number)[]): number | undefined {
  if (pathSegments.length === 0) return undefined;
  const targetKey = String(pathSegments[pathSegments.length - 1]);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.includes(`"${targetKey}"`)) {
      return i + 1;
    }
  }
  return undefined;
}

/**
 * Format a JSON syntax error with path, line, and column details.
 */
export function formatJsonSyntaxError(
  error: Error,
  sourceText: string,
  filePath: string,
): ConfigError {
  let line = 1;
  let column = 1;

  // Try extracting position from message (e.g., "... at position 123" or "... line 3 column 5")
  const posMatch = error.message.match(/position\s+(\d+)/i);
  const lineColMatch = error.message.match(/line\s+(\d+)\s+column\s+(\d+)/i);

  if (lineColMatch?.[1] && lineColMatch[2]) {
    line = Number.parseInt(lineColMatch[1], 10);
    column = Number.parseInt(lineColMatch[2], 10);
  } else if (posMatch?.[1]) {
    const pos = Number.parseInt(posMatch[1], 10);
    const loc = findLineAndColumnFromPosition(sourceText, pos);
    line = loc.line;
    column = loc.column;
  }

  const message = `Invalid JSON in ${filePath} (line ${line}, col ${column}): ${error.message}`;
  return new ConfigError(message, { filePath, line, column, cause: error });
}

/**
 * Format Zod validation errors with clear human-readable field paths and line hints.
 */
export function formatZodError(
  zodError: ZodError,
  sourceText?: string,
  filePath?: string,
): ConfigError {
  const issues = zodError.issues.map((issue) => {
    const fieldPath = issue.path.join(".") || "(root)";
    let lineHint = "";
    if (sourceText && issue.path.length > 0) {
      const line = findLineForKeyPath(sourceText, issue.path);
      if (line !== undefined) {
        lineHint = ` [line ${line}]`;
      }
    }
    return `  - Field "${fieldPath}"${lineHint}: ${issue.message}`;
  });

  const targetPath = filePath ? ` in ${filePath}` : "";
  const message = `Configuration validation failed${targetPath}:\n${issues.join("\n")}`;
  return new ConfigError(message, { filePath, cause: zodError });
}

/**
 * Safely parse JSON and validate against a Zod schema with rich error formatting.
 */
export function parseConfigWithSchema<T extends z.ZodTypeAny>(
  schema: T,
  rawText: string,
  filePath: string,
): z.output<T> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (err) {
    throw formatJsonSyntaxError(err as Error, rawText, filePath);
  }

  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    throw formatZodError(result.error, rawText, filePath);
  }

  return result.data;
}

/**
 * Load and validate local user configuration (~/.pi/agent/pi-cloud-agents.json).
 * If file does not exist, returns DEFAULT_LOCAL_CONFIG.
 */
export function loadLocalConfig(options?: {
  customDir?: string;
  fallbackToDefault?: boolean;
}): LocalConfig {
  const filePath = getLocalConfigPath(options?.customDir);
  const fallback = options?.fallbackToDefault ?? true;

  if (!fs.existsSync(filePath)) {
    if (fallback) {
      return { ...DEFAULT_LOCAL_CONFIG };
    }
    throw new ConfigError(`Local configuration file not found at ${filePath}`, { filePath });
  }

  const rawText = fs.readFileSync(filePath, "utf8");
  return parseConfigWithSchema(LocalConfigSchema, rawText, filePath);
}

/**
 * Save local configuration atomically with file mode 0600 (user read/write only).
 */
export function saveLocalConfig(config: LocalConfig, options?: { customDir?: string }): void {
  const validated = LocalConfigSchema.parse(config);
  const filePath = getLocalConfigPath(options?.customDir);
  const dir = path.dirname(filePath);

  // Ensure parent directory exists with 0700 permissions
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

  try {
    // Write temp file with 0600 mode
    fs.writeFileSync(tempPath, serialized, { mode: 0o600, encoding: "utf8" });
    fs.chmodSync(tempPath, 0o600);

    // Atomically rename temp file to target file
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup error
    }
    throw new ConfigError(
      `Failed to save local configuration to ${filePath}: ${(error as Error).message}`,
      {
        filePath,
        cause: error,
      },
    );
  }
}

/**
 * Load and validate repository configuration (<repo>/.pi/cloud-agents.json).
 * Returns null if the file does not exist.
 */
export function loadRepoConfig(repoDir?: string): RepoConfig | null {
  const filePath = getRepoConfigPath(repoDir);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const rawText = fs.readFileSync(filePath, "utf8");
  return parseConfigWithSchema(RepoConfigSchema, rawText, filePath);
}

/**
 * Save repository configuration (<repo>/.pi/cloud-agents.json).
 */
export function saveRepoConfig(config: RepoConfig, repoDir?: string): void {
  const validated = RepoConfigSchema.parse(config);
  const filePath = getRepoConfigPath(repoDir);
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

  try {
    fs.writeFileSync(tempPath, serialized, { encoding: "utf8" });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup error
    }
    throw new ConfigError(
      `Failed to save repository configuration to ${filePath}: ${(error as Error).message}`,
      {
        filePath,
        cause: error,
      },
    );
  }
}
