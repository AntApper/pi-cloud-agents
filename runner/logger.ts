/**
 * Structured JSON Logger for in-VM MicroVM runner.
 * Provides level filtering (debug, info, warn, error) and deep redaction
 * of registered secret values across strings, arguments, nested objects, arrays, and error stacks.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogEntry {
  level: LogLevel;
  time: string;
  msg?: string;
  [key: string]: unknown;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: (entry: LogEntry, rawJson: string) => void;
  defaultContext?: Record<string, unknown>;
}

export interface Logger {
  level: LogLevel;
  registerSecret(value: string | unknown): void;
  redact(value: unknown): unknown;
  debug(msgOrObj: string | Record<string, unknown>, ...args: unknown[]): void;
  info(msgOrObj: string | Record<string, unknown>, ...args: unknown[]): void;
  warn(msgOrObj: string | Record<string, unknown>, ...args: unknown[]): void;
  error(msgOrObj: string | Record<string, unknown>, ...args: unknown[]): void;
  child(context: Record<string, unknown>): Logger;
}

export class StructuredLogger implements Logger {
  public level: LogLevel;
  private readonly registeredSecrets = new Set<string>();
  private sortedSecrets: string[] = [];
  private readonly sink?: (entry: LogEntry, rawJson: string) => void;
  private readonly context: Record<string, unknown>;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? (process.env.LOG_LEVEL as LogLevel) ?? "info";
    this.sink = options.sink;
    this.context = options.defaultContext ?? {};
  }

  /**
   * Registers a secret string (minimum 4 characters) to be redacted from all future log outputs.
   * If an object or JSON string is passed, recursively extracts and registers embedded strings.
   */
  public registerSecret(value: string | unknown): void {
    if (!value) return;

    if (typeof value === "string") {
      const trimmed = value.trim();
      // Try to parse as JSON if it looks like a JSON object or array
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          const parsed = JSON.parse(trimmed);
          this.registerSecret(parsed);
          return;
        } catch {
          // Fall through to plain string registration
        }
      }

      if (trimmed.length >= 4) {
        this.registeredSecrets.add(trimmed);
        this.updateSortedSecrets();
      }
      return;
    }

    if (typeof value === "object" && value !== null) {
      if (Array.isArray(value)) {
        for (const item of value) {
          this.registerSecret(item);
        }
      } else {
        for (const val of Object.values(value)) {
          this.registerSecret(val);
        }
      }
    }
  }

  private updateSortedSecrets(): void {
    // Sort descending by length so longer substrings are matched and redacted first
    this.sortedSecrets = Array.from(this.registeredSecrets).sort((a, b) => b.length - a.length);
  }

  /**
   * Performs deep recursive redaction on any value.
   */
  public redact(value: unknown, visited = new WeakSet<object>()): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === "string") {
      return this.redactString(value);
    }

    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return value;
    }

    if (typeof value === "function") {
      return "[Function]";
    }

    if (value instanceof Error) {
      const redactedError: Record<string, unknown> = {
        name: value.name,
        message: this.redactString(value.message),
      };
      if (value.stack) {
        redactedError.stack = this.redactString(value.stack);
      }
      if ("code" in value) {
        redactedError.code = (value as { code: unknown }).code;
      }
      return redactedError;
    }

    if (typeof value === "object") {
      if (visited.has(value)) {
        return "[Circular]";
      }
      visited.add(value);

      if (Array.isArray(value)) {
        return value.map((item) => this.redact(item, visited));
      }

      const redactedObj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        redactedObj[k] = this.redact(v, visited);
      }
      return redactedObj;
    }

    return value;
  }

  private redactString(str: string): string {
    if (this.sortedSecrets.length === 0 || !str) {
      return str;
    }

    let result = str;
    for (const secret of this.sortedSecrets) {
      if (result.includes(secret)) {
        result = result.split(secret).join("[REDACTED]");
      }
    }
    return result;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_SEVERITY[level] >= (LOG_LEVEL_SEVERITY[this.level] ?? LOG_LEVEL_SEVERITY.info);
  }

  private writeLog(
    level: LogLevel,
    msgOrObj: string | Record<string, unknown>,
    args: unknown[],
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      level,
      time: new Date().toISOString(),
      ...this.context,
    };

    if (typeof msgOrObj === "string") {
      entry.msg = msgOrObj;
      if (args.length > 0) {
        if (
          args.length === 1 &&
          typeof args[0] === "object" &&
          args[0] !== null &&
          !Array.isArray(args[0]) &&
          !(args[0] instanceof Error)
        ) {
          Object.assign(entry, args[0]);
        } else {
          entry.args = args;
        }
      }
    } else if (typeof msgOrObj === "object" && msgOrObj !== null) {
      Object.assign(entry, msgOrObj);
      if (args.length > 0) {
        entry.args = args;
      }
    }

    // Apply deep redaction to the entire entry
    const redactedEntry = this.redact(entry) as LogEntry;
    const rawJson = JSON.stringify(redactedEntry);

    if (this.sink) {
      this.sink(redactedEntry, rawJson);
    } else {
      if (level === "error" || level === "warn") {
        process.stderr.write(`${rawJson}\n`);
      } else {
        process.stdout.write(`${rawJson}\n`);
      }
    }
  }

  public debug(msgOrObj: string | Record<string, unknown>, ...args: unknown[]): void {
    this.writeLog("debug", msgOrObj, args);
  }

  public info(msgOrObj: string | Record<string, unknown>, ...args: unknown[]): void {
    this.writeLog("info", msgOrObj, args);
  }

  public warn(msgOrObj: string | Record<string, unknown>, ...args: unknown[]): void {
    this.writeLog("warn", msgOrObj, args);
  }

  public error(msgOrObj: string | Record<string, unknown>, ...args: unknown[]): void {
    this.writeLog("error", msgOrObj, args);
  }

  public child(context: Record<string, unknown>): Logger {
    const childLogger = new StructuredLogger({
      level: this.level,
      sink: this.sink,
      defaultContext: {
        ...this.context,
        ...context,
      },
    });

    for (const secret of this.registeredSecrets) {
      childLogger.registerSecret(secret);
    }

    return childLogger;
  }
}

/**
 * Creates a new StructuredLogger instance.
 */
export function createLogger(options?: LoggerOptions): Logger {
  return new StructuredLogger(options);
}

/** Default singleton logger instance. */
export const defaultLogger: Logger = createLogger();
