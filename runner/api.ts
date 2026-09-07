/**
 * Runner HTTP and Streaming API (Port 8080).
 * Implements REST endpoints, Server-Sent Events (SSE) streaming with historical replay and heartbeats,
 * prompt steering/follow-up routing, request body size protection, and structured protocol errors.
 */

import fs from "node:fs";
import http from "node:http";
import { URL } from "node:url";
import {
  type FinalizeRequest,
  FinalizeRequestSchema,
  InterruptRequestSchema,
  PROTOCOL_ROUTES,
  PromptRequestSchema,
  ProtocolErrorCode,
  ProtocolHeaders,
  type RunnerStatus,
  RunnerStatusSchema,
} from "../shared/protocol.js";
import type { Logger } from "./logger.js";
import type { MetricsCollector } from "./metrics.js";
import { redactObject } from "./pi-extensions/redact.js";
import type { PiProcessManager } from "./pi-process.js";
import type { RunStateMachine } from "./state.js";
import { WebSocketRpcBridge } from "./ws-rpc.js";

export { PROTOCOL_ROUTES };

export const DEFAULT_API_PORT = 8080;
export const DEFAULT_API_HOST = "0.0.0.0";
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;
export const MAX_API_BODY_BYTES = 1048576; // 1 MB

export interface RunnerApiOptions {
  port?: number;
  host?: string;
  runStateMachine?: RunStateMachine;
  piProcess?: PiProcessManager;
  wsRpcBridge?: WebSocketRpcBridge;
  metricsCollector?: MetricsCollector;
  logger?: Logger;
  heartbeatIntervalMs?: number;
  maxBodyBytes?: number;
  getHistoricalEntries?: (
    sinceId?: string,
  ) => Promise<Array<Record<string, unknown>>> | Array<Record<string, unknown>>;
  onFinalize?: (req: FinalizeRequest) => Promise<void> | void;
  onShutdown?: () => Promise<void> | void;
  onCheckpoint?: () => Promise<void> | void;
  getMetrics?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  getStatus?: () => Promise<RunnerStatus> | RunnerStatus;
}

export class RunnerApiServer {
  private readonly options: RunnerApiOptions;
  private readonly port: number;
  private readonly host: string;
  private readonly logger?: Logger;
  private readonly heartbeatIntervalMs: number;
  private readonly maxBodyBytes: number;
  private readonly wsBridge: WebSocketRpcBridge;

  private server: http.Server | null = null;
  private isListening = false;
  private startTime = Date.now();
  private lastActivityTime = Date.now();
  private lastEventTime?: number;
  private isAgentStreaming = false;

  private activeSockets = new Set<http.IncomingMessage["socket"]>();
  private activeSseResponses = new Set<http.ServerResponse>();

  constructor(options: RunnerApiOptions = {}) {
    this.options = options;
    this.port =
      options.port ?? (process.env.APP_PORT ? Number(process.env.APP_PORT) : DEFAULT_API_PORT);
    this.host = options.host ?? DEFAULT_API_HOST;
    this.logger = options.logger;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? MAX_API_BODY_BYTES;
    this.wsBridge =
      options.wsRpcBridge ??
      new WebSocketRpcBridge({
        piProcess: options.piProcess,
        logger: options.logger,
      });

    this.bindPiProcessEvents();
  }

  private bindPiProcessEvents(): void {
    const pi = this.options.piProcess;
    if (!pi) return;

    pi.on("turn_start", () => {
      this.isAgentStreaming = true;
      this.recordActivity();
    });

    pi.on("agent_start", () => {
      this.isAgentStreaming = true;
      this.recordActivity();
    });

    pi.on("message_start", () => {
      this.isAgentStreaming = true;
      this.recordActivity();
    });

    pi.on("turn_end", () => {
      this.isAgentStreaming = false;
      this.recordActivity();
    });

    pi.on("agent_settled", () => {
      this.isAgentStreaming = false;
      this.recordActivity();
    });

    pi.on("stopped", () => {
      this.isAgentStreaming = false;
      this.recordActivity();
    });

    pi.on("failed", () => {
      this.isAgentStreaming = false;
      this.recordActivity();
    });

    pi.on("event", (event: Record<string, unknown>) => {
      this.lastEventTime = Date.now();
      this.recordActivity();
      this.broadcastSseEvent(event);
    });
  }

  public recordActivity(): void {
    this.lastActivityTime = Date.now();
  }

  public isStreaming(): boolean {
    return this.isAgentStreaming;
  }

  public setStreaming(streaming: boolean): void {
    this.isAgentStreaming = streaming;
  }

  public getActiveConnectionsCount(): number {
    return (
      this.activeSockets.size +
      this.activeSseResponses.size +
      this.wsBridge.getConnectedClientsCount()
    );
  }

  public getWsBridge(): WebSocketRpcBridge {
    return this.wsBridge;
  }

  public getPort(): number {
    if (this.server) {
      const addr = this.server.address();
      if (addr && typeof addr === "object") {
        return addr.port;
      }
    }
    return this.port;
  }

  public getServer(): http.Server | null {
    return this.server;
  }

  /**
   * Starts the HTTP server on configured port and host.
   */
  public async listen(port?: number, host?: string): Promise<void> {
    if (this.isListening) return;

    const targetPort = port ?? this.port;
    const targetHost = host ?? this.host;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.logger?.error?.(
          `Unhandled error in RunnerApiServer: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (!res.headersSent) {
          this.sendJson(res, 500, {
            error: {
              code: ProtocolErrorCode.INTERNAL_ERROR,
              message: "Internal server error in runner API",
            },
          });
        }
      });
    });

    this.server.on("connection", (socket) => {
      this.activeSockets.add(socket);
      socket.on("close", () => {
        this.activeSockets.delete(socket);
      });
    });

    this.wsBridge.attachServer(this.server);

    return new Promise((resolve, reject) => {
      this.server?.listen(targetPort, targetHost, () => {
        this.isListening = true;
        this.startTime = Date.now();
        this.logger?.info?.(`Runner HTTP API listening on http://${targetHost}:${this.getPort()}`);
        resolve();
      });

      this.server?.once("error", (err) => {
        this.logger?.error?.(`Runner HTTP API failed to bind: ${err.message}`);
        reject(err);
      });
    });
  }

  /**
   * Gracefully stops the HTTP server and closes all active sockets.
   */
  public async close(): Promise<void> {
    if (!this.server || !this.isListening) return;

    // Close WebSocket bridge
    await this.wsBridge.close().catch(() => {});

    // Close all SSE streams
    for (const res of this.activeSseResponses) {
      try {
        res.end();
      } catch {
        // Ignore socket end errors
      }
    }
    this.activeSseResponses.clear();

    // Destroy all active raw sockets
    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch {
        // Ignore socket destroy errors
      }
    }
    this.activeSockets.clear();

    return new Promise((resolve) => {
      this.server?.close(() => {
        this.isListening = false;
        this.server = null;
        resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.recordActivity();

    const host = req.headers.host || `localhost:${this.port}`;
    const url = new URL(req.url || "/", `http://${host}`);
    const method = (req.method || "GET").toUpperCase();
    const pathname = url.pathname;

    // 1. GET /healthz
    if (method === "GET" && pathname === "/healthz") {
      this.sendJson(res, 200, { status: "ok" });
      return;
    }

    // 2. GET /v1/status
    if (method === "GET" && pathname === "/v1/status") {
      await this.handleGetStatus(res);
      return;
    }

    // 3. GET /v1/manifest
    if (method === "GET" && pathname === "/v1/manifest") {
      await this.handleGetManifest(res);
      return;
    }

    // 4. GET /v1/entries
    if (method === "GET" && pathname === "/v1/entries") {
      await this.handleGetEntries(url, res);
      return;
    }

    // 5. GET /v1/events (SSE)
    if (method === "GET" && pathname === "/v1/events") {
      await this.handleGetEvents(req, url, res);
      return;
    }

    // 6. GET /v1/metrics
    if (method === "GET" && pathname === "/v1/metrics") {
      await this.handleGetMetrics(res);
      return;
    }

    // 7. POST /v1/prompt
    if (method === "POST" && pathname === "/v1/prompt") {
      await this.handlePostPrompt(req, res);
      return;
    }

    // 8. POST /v1/interrupt or POST /v1/abort
    if (method === "POST" && (pathname === "/v1/interrupt" || pathname === "/v1/abort")) {
      await this.handlePostAbort(req, res);
      return;
    }

    // 9. POST /v1/checkpoint
    if (method === "POST" && pathname === "/v1/checkpoint") {
      await this.handlePostCheckpoint(res);
      return;
    }

    // 10. POST /v1/finalize
    if (method === "POST" && pathname === "/v1/finalize") {
      await this.handlePostFinalize(req, res);
      return;
    }

    // 11. POST /v1/shutdown
    if (method === "POST" && pathname === "/v1/shutdown") {
      await this.handlePostShutdown(res);
      return;
    }

    // Route not found
    this.sendJson(res, 404, {
      error: {
        code: ProtocolErrorCode.NOT_FOUND,
        message: `Route '${method} ${pathname}' not found`,
      },
    });
  }

  private async handleGetStatus(res: http.ServerResponse): Promise<void> {
    if (this.options.getStatus) {
      try {
        const customStatus = await this.options.getStatus();
        this.sendJson(res, 200, customStatus);
        return;
      } catch (err) {
        this.logger?.error?.(
          `getStatus error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const sm = this.options.runStateMachine;
    const pi = this.options.piProcess;
    const manifest = sm?.getManifest();

    const uptimeSeconds = Math.max(0, Math.floor((Date.now() - this.startTime) / 1000));
    const nowIso = new Date().toISOString();

    const statusObj: RunnerStatus = {
      status: manifest?.status ?? "running",
      runId: manifest?.runId ?? "run-local",
      uptimeSeconds,
      activeConnections: this.getActiveConnectionsCount(),
      lastActivityAt: new Date(this.lastActivityTime).toISOString(),
      pi: {
        running: pi?.getState() === "running",
        pid: pi?.getPid(),
        currentSessionId: pi?.getSessionId(),
        lastEventAt: this.lastEventTime ? new Date(this.lastEventTime).toISOString() : nowIso,
      },
    };

    const validated = RunnerStatusSchema.parse(statusObj);
    this.sendJson(res, 200, validated);
  }

  private async handleGetManifest(res: http.ServerResponse): Promise<void> {
    const sm = this.options.runStateMachine;
    if (!sm) {
      this.sendJson(res, 404, {
        error: {
          code: ProtocolErrorCode.NOT_FOUND,
          message: "Run manifest is not initialized",
        },
      });
      return;
    }

    const manifest = sm.getManifest();
    this.sendJson(res, 200, manifest);
  }

  private async handleGetEntries(url: URL, res: http.ServerResponse): Promise<void> {
    const since = url.searchParams.get("since") || undefined;
    const entries = await this.fetchHistoricalEntries(since);
    this.sendJson(res, 200, entries);
  }

  private async fetchHistoricalEntries(sinceId?: string): Promise<Array<Record<string, unknown>>> {
    if (this.options.getHistoricalEntries) {
      try {
        return await this.options.getHistoricalEntries(sinceId);
      } catch (err) {
        this.logger?.warn?.(
          `getHistoricalEntries error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Default: read from session file if available
    const sessionFile =
      this.options.piProcess?.getSessionFile() ||
      this.options.runStateMachine?.getTrackedSessionFilePath();
    if (sessionFile && fs.existsSync(sessionFile)) {
      try {
        const content = fs.readFileSync(sessionFile, "utf8");
        const lines = content.split("\n").filter((l) => l.trim().length > 0);
        const allEntries: Array<Record<string, unknown>> = [];

        for (const line of lines) {
          try {
            allEntries.push(JSON.parse(line));
          } catch {
            // Ignore malformed lines
          }
        }

        if (!sinceId) {
          return allEntries;
        }

        const sinceIndex = allEntries.findIndex(
          (e) => e.id === sinceId || (e as { entryId?: string }).entryId === sinceId,
        );
        if (sinceIndex !== -1) {
          return allEntries.slice(sinceIndex + 1);
        }
        return allEntries;
      } catch (err) {
        this.logger?.warn?.(
          `Failed to read session file for entries: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return [];
  }

  private async handleGetEvents(
    req: http.IncomingMessage,
    url: URL,
    res: http.ServerResponse,
  ): Promise<void> {
    const headerLastEventId = req.headers[ProtocolHeaders.LAST_EVENT_ID];
    const lastEventId =
      (typeof headerLastEventId === "string"
        ? headerLastEventId
        : Array.isArray(headerLastEventId)
          ? headerLastEventId[0]
          : undefined) ||
      url.searchParams.get("since") ||
      undefined;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    this.activeSseResponses.add(res);

    // 1. Replay past entries if requested
    if (lastEventId) {
      const replayEntries = await this.fetchHistoricalEntries(lastEventId);
      for (const entry of replayEntries) {
        this.writeSseFrame(res, entry);
      }
    }

    // 2. Setup heartbeat timer
    const heartbeatTimer = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(": heartbeat\n\n");
      }
    }, this.heartbeatIntervalMs);

    const cleanup = () => {
      clearInterval(heartbeatTimer);
      this.activeSseResponses.delete(res);
    };

    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  }

  private writeSseFrame(res: http.ServerResponse, event: Record<string, unknown>): void {
    if (res.writableEnded || res.destroyed) return;

    const sanitized = redactObject(event);
    const id = (sanitized.id as string) || (sanitized.entryId as string) || `evt-${Date.now()}`;
    const type = (sanitized.type as string) || "message";
    const data = JSON.stringify(sanitized);

    res.write(`id: ${id}\nevent: ${type}\ndata: ${data}\n\n`);
  }

  private broadcastSseEvent(event: Record<string, unknown>): void {
    for (const res of this.activeSseResponses) {
      this.writeSseFrame(res, event);
    }
  }

  private async handleGetMetrics(res: http.ServerResponse): Promise<void> {
    if (this.options.metricsCollector) {
      this.sendJson(res, 200, this.options.metricsCollector.getFullMetrics());
      return;
    }

    if (this.options.getMetrics) {
      try {
        const metrics = await this.options.getMetrics();
        this.sendJson(res, 200, metrics);
        return;
      } catch (err) {
        this.logger?.error?.(
          `getMetrics error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.sendJson(res, 200, {
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      activeConnections: this.getActiveConnectionsCount(),
      lastActivityAt: new Date(this.lastActivityTime).toISOString(),
    });
  }

  private async handlePostPrompt(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const rawBody = await this.readBody(req, res);
    if (rawBody === null) return;

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      this.sendJson(res, 400, {
        error: {
          code: ProtocolErrorCode.INVALID_PAYLOAD,
          message: "Request body must be valid JSON",
        },
      });
      return;
    }

    const validationResult = PromptRequestSchema.safeParse(parsedBody);
    if (!validationResult.success) {
      this.sendJson(res, 400, {
        error: {
          code: ProtocolErrorCode.INVALID_PAYLOAD,
          message: validationResult.error.message,
          details: validationResult.error.errors,
        },
      });
      return;
    }

    const promptReq = validationResult.data;
    const message = promptReq.prompt || promptReq.message || "";
    const mode = promptReq.mode || (promptReq.steer ? "steer" : "prompt");
    const isFollowUp = mode === "followUp" || mode === "follow_up";

    // Check conflict if agent is currently streaming and request is a standard prompt without steer / followUp
    if (this.isAgentStreaming && mode === "prompt" && !promptReq.steer) {
      this.sendJson(res, 409, {
        error: {
          code: ProtocolErrorCode.CONFLICT,
          message:
            "Agent is currently busy streaming. Provide mode='steer' or mode='followUp' to interrupt or queue.",
        },
      });
      return;
    }

    const pi = this.options.piProcess;
    if (pi) {
      try {
        const rpcMode = isFollowUp ? "follow_up" : mode === "steer" ? "steer" : "prompt";
        await pi.prompt(message, rpcMode);
      } catch (err) {
        this.sendJson(res, 500, {
          error: {
            code: ProtocolErrorCode.INTERNAL_ERROR,
            message: `Failed to forward prompt to pi process: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
        return;
      }
    }

    this.sendJson(res, 200, {
      status: "accepted",
      mode,
    });
  }

  private async handlePostAbort(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const rawBody = await this.readBody(req, res);
    if (rawBody === null) return;

    if (rawBody.length > 0) {
      try {
        const parsed = JSON.parse(rawBody);
        InterruptRequestSchema.safeParse(parsed);
      } catch {
        // Ignore body parsing errors for abort
      }
    }

    const pi = this.options.piProcess;
    if (pi) {
      try {
        await pi.abort();
      } catch (err) {
        this.logger?.warn?.(
          `Abort error from pi process: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.sendJson(res, 200, { status: "interrupted" });
  }

  private async handlePostCheckpoint(res: http.ServerResponse): Promise<void> {
    if (this.options.onCheckpoint) {
      try {
        await this.options.onCheckpoint();
      } catch (err) {
        this.sendJson(res, 500, {
          error: {
            code: ProtocolErrorCode.INTERNAL_ERROR,
            message: `Checkpoint failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
        return;
      }
    } else {
      const sm = this.options.runStateMachine;
      if (sm) {
        try {
          await sm.flushSession();
          await sm.recordTimeline("checkpoint", "Manual checkpoint requested");
        } catch (err) {
          this.sendJson(res, 500, {
            error: {
              code: ProtocolErrorCode.INTERNAL_ERROR,
              message: `Checkpoint flush failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          });
          return;
        }
      }
    }

    this.sendJson(res, 200, { status: "checkpointed" });
  }

  private async handlePostFinalize(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const rawBody = await this.readBody(req, res);
    if (rawBody === null) return;

    let finalizeReq: FinalizeRequest = {};
    if (rawBody.length > 0) {
      try {
        const parsed = JSON.parse(rawBody);
        const result = FinalizeRequestSchema.safeParse(parsed);
        if (result.success) {
          finalizeReq = result.data;
        }
      } catch {
        // Continue with default finalizeReq
      }
    }

    if (this.options.onFinalize) {
      try {
        await this.options.onFinalize(finalizeReq);
      } catch (err) {
        this.sendJson(res, 500, {
          error: {
            code: ProtocolErrorCode.INTERNAL_ERROR,
            message: `Finalize execution failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
        return;
      }
    }

    this.sendJson(res, 200, { status: "finalizing" });
  }

  private async handlePostShutdown(res: http.ServerResponse): Promise<void> {
    this.sendJson(res, 200, { status: "shutting_down" });

    if (this.options.onShutdown) {
      setImmediate(async () => {
        try {
          await this.options.onShutdown?.();
        } catch (err) {
          this.logger?.error?.(
            `Shutdown execution error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    }
  }

  private readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<string | null> {
    return new Promise((resolve) => {
      let totalBytes = 0;
      const chunks: Buffer[] = [];

      req.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > this.maxBodyBytes) {
          this.sendJson(res, 413, {
            error: {
              code: ProtocolErrorCode.PAYLOAD_TOO_LARGE,
              message: `Request body exceeds maximum size limit of ${this.maxBodyBytes} bytes`,
            },
          });
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body);
      });

      req.on("error", (err) => {
        this.logger?.warn?.(`Request stream error: ${err.message}`);
        this.sendJson(res, 400, {
          error: {
            code: ProtocolErrorCode.INVALID_PAYLOAD,
            message: `Error reading request body: ${err.message}`,
          },
        });
        resolve(null);
      });
    });
  }

  private sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
    if (res.headersSent || res.writableEnded) return;

    const sanitized = redactObject(data);
    const body = JSON.stringify(sanitized, null, 2);
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body, "utf8"),
    });
    res.end(body);
  }
}
