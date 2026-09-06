/**
 * Lifecycle hook server for AWS Lambda MicroVM runtime.
 * Listens on port 9000 (0.0.0.0:9000) and handles MicroVM hypervisor lifecycle events:
 * - GET /ready: Readiness check
 * - GET/POST /validate: Image/environment validation probe
 * - POST /run: MicroVM launch with payload delivery
 * - POST /resume: MicroVM resume from suspension
 * - POST /suspend: MicroVM pre-suspension checkpoint
 * - POST /terminate: MicroVM termination notice
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { promisify } from "node:util";
import { type LaunchPayload, ProtocolErrorCode, decodeLaunchPayload } from "../shared/protocol.js";

const execFileAsync = promisify(execFile);

/** Default port for MicroVM lifecycle hook endpoints. */
export const DEFAULT_HOOK_PORT = 9000;
export const DEFAULT_HOOK_HOST = "0.0.0.0";
export const HOOK_PATH_PREFIX = "/aws/lambda-microvms/runtime/v1";

/** Maximum body size for lifecycle hook requests (64 KB). */
export const MAX_HOOK_BODY_BYTES = 65536;

/** Default timeouts for hook handlers. */
export const DEFAULT_HOOK_TIMEOUT_MS = {
  run: 25000,
  resume: 13000,
  suspend: 43000,
  terminate: 43000,
} as const;

export interface ValidationResult {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

export interface RunHookData {
  microvmId: string;
  payload: LaunchPayload | null;
  rawPayload: string;
  error?: Error;
}

export interface HookServerOptions {
  port?: number;
  host?: string;
  onRun?: (data: RunHookData) => Promise<void> | void;
  onResume?: () => Promise<void> | void;
  onSuspend?: () => Promise<void> | void;
  onTerminate?: () => Promise<void> | void;
  validateSelfCheck?: () => Promise<ValidationResult> | ValidationResult;
  timeouts?: {
    run?: number;
    resume?: number;
    suspend?: number;
    terminate?: number;
  };
  logger?: {
    debug?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
}

/**
 * Executes default environment and resource self-check for /validate probe.
 */
export async function defaultSelfCheck(): Promise<ValidationResult> {
  const details: Record<string, unknown> = {};

  // 1. Check Git availability
  try {
    const { stdout } = await execFileAsync("git", ["--version"]);
    details.git = stdout.trim();
  } catch (err) {
    details.git = { error: err instanceof Error ? err.message : String(err) };
  }

  // 2. Check Node runtime version
  details.node = process.version;
  details.arch = process.arch;
  details.platform = process.platform;

  // 3. Check Pi binary availability (best effort)
  try {
    const { stdout } = await execFileAsync("pi", ["--version"]);
    details.pi = stdout.trim();
  } catch (err) {
    details.pi = { error: err instanceof Error ? err.message : String(err) };
  }

  // 4. Check disk space on working directory or /tmp
  const checkDir = fs.existsSync("/work") ? "/work" : process.cwd();
  try {
    if (typeof fs.promises.statfs === "function") {
      const stats = await fs.promises.statfs(checkDir);
      const freeBytes = stats.bavail * stats.bsize;
      const totalBytes = stats.blocks * stats.bsize;
      details.disk = {
        directory: checkDir,
        freeBytes,
        totalBytes,
        freeMb: Math.round(freeBytes / (1024 * 1024)),
      };

      // Fail if free disk is under 20MB
      if (freeBytes < 20 * 1024 * 1024) {
        return {
          ok: false,
          message: `Insufficient free disk space in ${checkDir} (${Math.round(freeBytes / (1024 * 1024))} MB free)`,
          details,
        };
      }
    }
  } catch (err) {
    details.disk = { error: err instanceof Error ? err.message : String(err) };
  }

  return {
    ok: true,
    message: "Self-check completed successfully",
    details,
  };
}

/**
 * Runs an asynchronous action with a bounded deadline.
 * Returns true if action completed before timeout, false if timed out.
 */
async function runWithTimeout(
  action: () => Promise<void> | void,
  timeoutMs: number,
  actionName: string,
  logger?: HookServerOptions["logger"],
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      logger?.warn?.(`Hook handler '${actionName}' exceeded bounded deadline of ${timeoutMs}ms`);
      resolve(false);
    }, timeoutMs);
  });

  const actionPromise = (async () => {
    try {
      await action();
      return true;
    } catch (err) {
      logger?.error?.(
        `Hook handler '${actionName}' threw error:`,
        err instanceof Error ? err.message : String(err),
      );
      return true;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  })();

  return Promise.race([actionPromise, timeoutPromise]);
}

/**
 * Reads and parses JSON body from an incoming HTTP request.
 */
async function readJsonBody<T = unknown>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytesRead = 0;

    req.on("data", (chunk: Buffer) => {
      bytesRead += chunk.length;
      if (bytesRead > MAX_HOOK_BODY_BYTES) {
        reject(new Error(`Request body exceeds maximum size of ${MAX_HOOK_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({} as T);
        return;
      }
      try {
        const bodyStr = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(bodyStr);
        resolve(parsed as T);
      } catch (err) {
        reject(
          new Error(
            `Failed to parse JSON body: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });

    req.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Lifecycle hook HTTP server for MicroVM hypervisor interactions.
 */
export class LifecycleHookServer {
  private server: http.Server | null = null;
  private isInitialized = false;
  private runReceived = false;
  private readonly options: HookServerOptions;

  constructor(options: HookServerOptions = {}) {
    this.options = options;
  }

  /**
   * Sets whether the runner application is fully initialized and ready to receive traffic.
   */
  public setReady(ready: boolean): void {
    this.isInitialized = ready;
    this.options.logger?.info?.(`LifecycleHookServer readiness state updated: ready=${ready}`);
  }

  /**
   * Returns whether the runner application is marked ready.
   */
  public isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Starts the HTTP hook server.
   */
  public async start(): Promise<number> {
    if (this.server) {
      return this.getPort();
    }

    const port =
      this.options.port ??
      (process.env.HOOK_PORT ? Number.parseInt(process.env.HOOK_PORT, 10) : DEFAULT_HOOK_PORT);
    const host = this.options.host ?? DEFAULT_HOOK_HOST;

    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          this.options.logger?.error?.("Unhandled error handling hook request:", err);
          if (!res.headersSent) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", error: String(err) }));
          }
        });
      });

      srv.on("error", (err) => {
        reject(err);
      });

      srv.listen(port, host, () => {
        this.server = srv;
        const addr = srv.address();
        const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
        this.options.logger?.info?.(`Lifecycle hook server listening on ${host}:${actualPort}`);
        resolve(actualPort);
      });
    });
  }

  /**
   * Returns the bound port number.
   */
  public getPort(): number {
    if (!this.server) {
      throw new Error("LifecycleHookServer is not running");
    }
    const addr = this.server.address();
    if (typeof addr === "object" && addr !== null) {
      return addr.port;
    }
    return this.options.port ?? DEFAULT_HOOK_PORT;
  }

  /**
   * Returns the underlying Node HTTP server.
   */
  public getServer(): http.Server | null {
    return this.server;
  }

  /**
   * Gracefully shuts down the HTTP hook server.
   */
  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise((resolve) => {
      this.server?.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Handles incoming HTTP requests on lifecycle hook routes.
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = (req.method || "GET").toUpperCase();
    const url = req.url || "/";
    const parsedPath = url.split("?")[0] || "/";

    // Normalize path by removing trailing slash if not root
    const normalizedPath =
      parsedPath.length > 1 && parsedPath.endsWith("/") ? parsedPath.slice(0, -1) : parsedPath;

    // 1. GET /ready
    if (
      method === "GET" &&
      (normalizedPath === `${HOOK_PATH_PREFIX}/ready` || normalizedPath === "/ready")
    ) {
      if (this.isInitialized) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ready" }));
      } else {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "initializing",
            message: "Runner service is initializing",
          }),
        );
      }
      return;
    }

    // 2. GET/POST /validate
    if (
      (method === "GET" || method === "POST") &&
      (normalizedPath === `${HOOK_PATH_PREFIX}/validate` || normalizedPath === "/validate")
    ) {
      const checkFn = this.options.validateSelfCheck ?? defaultSelfCheck;
      try {
        const result = await checkFn();
        if (result.ok) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "valid",
              message: result.message ?? "Validation check passed",
              details: result.details,
            }),
          );
        } else {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "invalid",
              error: result.message ?? "Validation check failed",
              details: result.details,
            }),
          );
        }
      } catch (err) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "invalid",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return;
    }

    // 3. POST /run
    if (
      method === "POST" &&
      (normalizedPath === `${HOOK_PATH_PREFIX}/run` || normalizedPath === "/run")
    ) {
      let body: { microvmId?: string; runHookPayload?: string } = {};
      try {
        body = await readJsonBody<{ microvmId?: string; runHookPayload?: string }>(req);
      } catch (err) {
        this.options.logger?.warn?.("Failed to parse /run body:", err);
      }

      const microvmId = body.microvmId || "microvm-unknown";
      const rawPayload = body.runHookPayload || "";

      let payload: LaunchPayload | null = null;
      let parseError: Error | undefined;

      try {
        if (!rawPayload) {
          throw new Error("Missing required 'runHookPayload' in request body");
        }
        payload = decodeLaunchPayload(rawPayload);
      } catch (err) {
        parseError = err instanceof Error ? err : new Error(String(err));
        this.options.logger?.error?.(
          `Failed to decode LaunchPayload in /run hook: ${parseError.message}`,
        );
      }

      // Idempotency flag check
      const isDuplicate = this.runReceived;
      this.runReceived = true;

      // Always return 200 fast (< 200ms) to satisfy hypervisor contract
      res.writeHead(200, { "Content-Type": "application/json" });
      if (parseError) {
        res.end(
          JSON.stringify({
            status: "accepted",
            warning: "invalid_payload",
            code: ProtocolErrorCode.INVALID_PAYLOAD,
            error: parseError.message,
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            status: "accepted",
            runId: payload?.runId,
            duplicate: isDuplicate,
          }),
        );
      }

      // Trigger onRun handler asynchronously
      if (this.options.onRun) {
        const runData: RunHookData = {
          microvmId,
          payload,
          rawPayload,
          error: parseError,
        };
        queueMicrotask(() => {
          Promise.resolve(this.options.onRun?.(runData)).catch((err) => {
            this.options.logger?.error?.("Async onRun handler failed:", err);
          });
        });
      }
      return;
    }

    // 4. POST /resume
    if (
      method === "POST" &&
      (normalizedPath === `${HOOK_PATH_PREFIX}/resume` || normalizedPath === "/resume")
    ) {
      const timeoutMs = this.options.timeouts?.resume ?? DEFAULT_HOOK_TIMEOUT_MS.resume;
      if (this.options.onResume) {
        await runWithTimeout(this.options.onResume, timeoutMs, "resume", this.options.logger);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", action: "resume" }));
      return;
    }

    // 5. POST /suspend
    if (
      method === "POST" &&
      (normalizedPath === `${HOOK_PATH_PREFIX}/suspend` || normalizedPath === "/suspend")
    ) {
      const timeoutMs = this.options.timeouts?.suspend ?? DEFAULT_HOOK_TIMEOUT_MS.suspend;
      if (this.options.onSuspend) {
        await runWithTimeout(this.options.onSuspend, timeoutMs, "suspend", this.options.logger);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", action: "suspend" }));
      return;
    }

    // 6. POST /terminate
    if (
      method === "POST" &&
      (normalizedPath === `${HOOK_PATH_PREFIX}/terminate` || normalizedPath === "/terminate")
    ) {
      const timeoutMs = this.options.timeouts?.terminate ?? DEFAULT_HOOK_TIMEOUT_MS.terminate;
      if (this.options.onTerminate) {
        await runWithTimeout(this.options.onTerminate, timeoutMs, "terminate", this.options.logger);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", action: "terminate" }));
      return;
    }

    // 7. Unknown hook route fallback: always return 200 OK for robustness and hypervisor compatibility
    this.options.logger?.debug?.(`Unknown hook route accessed: ${method} ${normalizedPath}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        method,
        path: normalizedPath,
      }),
    );
  }
}
