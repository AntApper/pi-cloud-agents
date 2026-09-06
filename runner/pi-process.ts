/**
 * Pi Process Manager and RPC Bridge.
 * Spawns headless pi in RPC mode, provides LF-only JSONL streaming parser (U+2028/U+2029 safe),
 * correlates request/response by unique ID, fans out events, supports health probes,
 * handles crash recovery with --session continuation, and performs graceful teardown.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { ThinkingConfig } from "../shared/protocol.js";
import { ProtocolErrorCode } from "../shared/protocol.js";
import type { Logger } from "./logger.js";

export const DEFAULT_PI_SESSION_DIR = "/work/.pi-sessions";
export const DEFAULT_RPC_TIMEOUT_MS = 30000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

export class PiProcessCrashError extends Error {
  public readonly code = ProtocolErrorCode.PI_PROCESS_CRASH;
  public readonly exitCode: number | null;
  public readonly crashCount: number;

  constructor(exitCode: number | null, crashCount: number, message?: string) {
    super(
      message ?? `Pi process crashed with exit code ${exitCode ?? "null"} (crashes: ${crashCount})`,
    );
    this.name = "PiProcessCrashError";
    this.exitCode = exitCode;
    this.crashCount = crashCount;
  }
}

export interface PiProcessOptions {
  workingDirectory: string;
  sessionDir?: string;
  sessionFile?: string;
  env?: NodeJS.ProcessEnv | Record<string, string>;
  piBinary?: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingConfig;
  approve?: boolean;
  extensions?: string[];
  logger?: Logger;
  maxRestarts?: number;
}

export type PiProcessState = "stopped" | "starting" | "running" | "recovering" | "failed";

export interface RpcResponse<T = unknown> {
  id?: string;
  type: string;
  success?: boolean;
  data?: T;
  error?: {
    code?: string;
    message: string;
  };
}

export class PiProcessManager extends EventEmitter {
  private readonly options: PiProcessOptions;
  private readonly logger?: Logger;
  private readonly sessionDir: string;
  private readonly maxRestarts: number;

  private child: ChildProcess | null = null;
  private state: PiProcessState = "stopped";
  private crashCount = 0;
  private isIntentionallyStopped = false;

  private currentSessionId?: string;
  private currentSessionFile?: string;

  private stdoutBuffer = Buffer.alloc(0);
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(options: PiProcessOptions) {
    super();
    this.options = options;
    this.logger = options.logger;
    this.sessionDir = options.sessionDir ?? DEFAULT_PI_SESSION_DIR;
    this.maxRestarts = options.maxRestarts ?? 1;
    this.currentSessionFile = options.sessionFile;
  }

  public getState(): PiProcessState {
    return this.state;
  }

  public getSessionId(): string | undefined {
    return this.currentSessionId;
  }

  public getSessionFile(): string | undefined {
    return this.currentSessionFile;
  }

  public getPid(): number | undefined {
    return this.child?.pid;
  }

  /**
   * Spawns the pi process in RPC mode.
   */
  public async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") {
      return;
    }

    this.isIntentionallyStopped = false;
    this.state = "starting";
    fs.mkdirSync(this.sessionDir, { recursive: true });

    await this.spawnProcess();
  }

  private buildCommandLineArgs(): { command: string; args: string[] } {
    const piBinary = this.options.piBinary ?? "pi";
    const args: string[] = ["--mode", "rpc"];

    if (this.currentSessionFile && fs.existsSync(this.currentSessionFile)) {
      args.push("--session", this.currentSessionFile);
    } else {
      args.push("--session-dir", this.sessionDir);
    }

    if (this.options.approve ?? true) {
      args.push("--approve");
    }

    if (this.options.provider) {
      args.push("--provider", this.options.provider);
    }

    if (this.options.model) {
      args.push("--model", this.options.model);
    }

    if (this.options.thinking) {
      if (typeof this.options.thinking === "boolean") {
        if (this.options.thinking) args.push("--thinking", "true");
      } else if (this.options.thinking.budgetTokens) {
        args.push("--thinking", String(this.options.thinking.budgetTokens));
      }
    }

    if (this.options.extensions) {
      for (const ext of this.options.extensions) {
        args.push("-e", ext);
      }
    }

    // If piBinary is a JS/TS file path (for testing or scripted runner), spawn with node
    if (
      piBinary.endsWith(".ts") ||
      piBinary.endsWith(".js") ||
      piBinary.includes("/") ||
      piBinary.includes("\\")
    ) {
      return {
        command: process.execPath,
        args: ["--no-warnings", "--experimental-strip-types", piBinary, ...args],
      };
    }

    return { command: piBinary, args };
  }

  private async spawnProcess(): Promise<void> {
    const { command, args } = this.buildCommandLineArgs();
    this.logger?.info?.(
      `Spawning pi RPC process: ${command} ${args.join(" ")} (cwd: ${this.options.workingDirectory})`,
    );

    const child = spawn(command, args, {
      cwd: this.options.workingDirectory,
      env: {
        ...process.env,
        ...(this.options.env || {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child = child;
    this.stdoutBuffer = Buffer.alloc(0);

    child.stdout.on("data", (chunk: Buffer) => {
      this.handleStdoutChunk(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trimEnd();
      this.logger?.warn?.(`[pi stderr] ${text}`);
      this.emit("stderr", text);
    });

    const exitPromise = new Promise<void>((resolve, reject) => {
      child.on("error", (err) => {
        this.logger?.error?.(`Failed to spawn pi process: ${err.message}`);
        this.handleProcessExit(null, err);
        reject(err);
      });

      child.on("close", (code) => {
        this.handleProcessExit(code, null);
        resolve();
      });
    });

    // Probe initial health via get_state
    try {
      this.state = "running";
      this.emit("started", { pid: child.pid });

      const stateResult = await this.sendRequest<{
        sessionId?: string;
        sessionFile?: string;
      }>("get_state", {}, 5000);

      if (stateResult?.sessionId) {
        this.currentSessionId = stateResult.sessionId;
      }
      if (stateResult?.sessionFile) {
        this.currentSessionFile = stateResult.sessionFile;
      }
    } catch (err) {
      if (this.state !== "failed" && !this.isIntentionallyStopped) {
        this.logger?.warn?.(
          `Initial health probe response: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Keep track of exit promise in background
    exitPromise.catch(() => {});
  }

  /**
   * Strict LF-only JSONL stream chunk parser.
   * Splits on byte 0x0A ('\n') only, ensuring U+2028 and U+2029 are untouched.
   */
  private handleStdoutChunk(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf(0x0a);
      if (newlineIndex === -1) break;

      const lineBuffer = this.stdoutBuffer.subarray(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newlineIndex + 1);

      const lineText = lineBuffer.toString("utf8").trim();
      if (lineText.length === 0) continue;

      try {
        const parsed = JSON.parse(lineText) as Record<string, unknown>;
        this.handleRpcMessage(parsed);
      } catch (err) {
        this.logger?.error?.(
          `Failed to parse pi JSONL line: ${lineText} (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }

  private handleRpcMessage(msg: Record<string, unknown>): void {
    // 1. Check if this message resolves an in-flight correlated request
    const id = msg.id as string | undefined;
    if (id && this.pendingRequests.has(id)) {
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id);

        if (msg.error) {
          const errObj = msg.error as { message?: string };
          pending.reject(new Error(errObj.message ?? `RPC Error for request '${id}'`));
        } else {
          pending.resolve(msg.data ?? msg);
        }
      }
    }

    // 2. Track sessionId if present
    if (typeof msg.sessionId === "string") {
      this.currentSessionId = msg.sessionId;
      if (!this.currentSessionFile) {
        this.currentSessionFile = path.join(this.sessionDir, `${msg.sessionId}.jsonl`);
      }
    }

    // 3. Fan-out events
    const type = msg.type as string;
    if (type) {
      this.emit(type, msg);
    }
    this.emit("event", msg);
  }

  private async handleProcessExit(exitCode: number | null, _error?: Error | null): Promise<void> {
    this.child = null;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(
          `pi process exited with code ${exitCode ?? "null"} before request '${id}' completed`,
        ),
      );
    }
    this.pendingRequests.clear();

    if (this.isIntentionallyStopped) {
      this.state = "stopped";
      this.emit("stopped", { exitCode });
      return;
    }

    // Handle unexpected crash
    this.crashCount++;
    this.logger?.error?.(
      `pi process unexpectedly exited (exit code: ${exitCode}, crash count: ${this.crashCount})`,
    );

    if (this.crashCount <= this.maxRestarts) {
      this.state = "recovering";
      this.emit("crashed", { exitCode, crashCount: this.crashCount });

      try {
        this.logger?.info?.(
          `Attempting automatic restart continuation with session file '${this.currentSessionFile}'`,
        );
        await this.spawnProcess();
        this.emit("recovered", {
          crashCount: this.crashCount,
          sessionId: this.currentSessionId,
        });
      } catch (restartErr) {
        this.logger?.error?.(
          `Failed to restart pi process: ${restartErr instanceof Error ? restartErr.message : String(restartErr)}`,
        );
        this.state = "failed";
        const fatalErr = new PiProcessCrashError(
          exitCode,
          this.crashCount,
          `Failed to recover pi process: ${restartErr instanceof Error ? restartErr.message : String(restartErr)}`,
        );
        this.emit("failed", fatalErr);
      }
    } else {
      this.state = "failed";
      const fatalErr = new PiProcessCrashError(
        exitCode,
        this.crashCount,
        `pi process crashed repeatedly (${this.crashCount} times), exceeding max restart limit (${this.maxRestarts})`,
      );
      this.emit("failed", fatalErr);
    }
  }

  /**
   * Sends a typed RPC request to the child process and awaits correlated response.
   */
  public sendRequest<T = unknown>(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.child || this.state !== "running") {
      return Promise.reject(
        new Error(
          `Cannot send RPC request '${type}': pi process is not running (state: ${this.state})`,
        ),
      );
    }

    const id = `req-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const requestMessage = {
      id,
      type,
      ...payload,
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC request '${type}' (id: ${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
      });

      const line = `${JSON.stringify(requestMessage)}\n`;
      this.child?.stdin?.write(line, "utf8", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Submits a user prompt, steer, or follow_up message.
   */
  public async prompt(
    message: string,
    mode: "prompt" | "steer" | "follow_up" = "prompt",
  ): Promise<unknown> {
    return this.sendRequest(mode, { message });
  }

  /**
   * Sends abort command to cancel active turn.
   */
  public async abort(): Promise<unknown> {
    return this.sendRequest("abort", {});
  }

  /**
   * Probes process state via get_state RPC.
   */
  public async queryState(): Promise<unknown> {
    return this.sendRequest("get_state", {});
  }

  /**
   * Graceful stop: sends abort -> SIGTERM -> SIGKILL deadline.
   */
  public async stop(gracefulTimeoutMs: number = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    this.isIntentionallyStopped = true;

    if (!this.child) {
      this.state = "stopped";
      return;
    }

    const child = this.child;

    // 1. Try sending abort command over RPC
    try {
      await this.abort().catch(() => {});
    } catch {
      // Ignore abort errors during shutdown
    }

    // 2. Send SIGTERM and wait bounded duration
    return new Promise<void>((resolve) => {
      let isClosed = false;

      const killTimer = setTimeout(() => {
        if (!isClosed) {
          this.logger?.warn?.(
            "pi process did not exit on SIGTERM within deadline. Sending SIGKILL.",
          );
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignore kill error
          }
        }
      }, gracefulTimeoutMs);

      child.once("close", () => {
        isClosed = true;
        clearTimeout(killTimer);
        this.child = null;
        this.state = "stopped";
        resolve();
      });

      try {
        child.kill("SIGTERM");
      } catch {
        isClosed = true;
        clearTimeout(killTimer);
        this.child = null;
        this.state = "stopped";
        resolve();
      }
    });
  }
}
