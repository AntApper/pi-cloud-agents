/**
 * WebSocket RPC Passthrough & Fan-out (Port 8080 /v1/rpc and /ws/rpc).
 * Implements low-latency bidirectional channel into the in-VM pi RPC process,
 * subprotocol negotiation (lambda-microvms), event broadcasting with backpressure protection,
 * and attached client tracking with 120s extension UI auto-cancellation.
 */

import type http from "node:http";
import type stream from "node:stream";
import { URL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { Logger } from "./logger.js";
import { redactObject } from "./pi-extensions/redact.js";
import type { PiProcessManager } from "./pi-process.js";

export const DEFAULT_WS_MAX_BUFFERED_AMOUNT = 65536; // 64 KB
export const DEFAULT_UI_REQUEST_TIMEOUT_MS = 120000; // 120 seconds

export const SUPPORTED_SUBPROTOCOLS = ["lambda-microvms", "lambda-microvms.port.8080"] as const;

export interface WebSocketRpcBridgeOptions {
  piProcess?: PiProcessManager;
  logger?: Logger;
  maxBufferedAmount?: number;
  uiRequestTimeoutMs?: number;
}

interface ClientConnection {
  id: string;
  ws: WebSocket;
  isAttached: boolean;
  connectedAt: number;
}

export class WebSocketRpcBridge {
  private readonly options: WebSocketRpcBridgeOptions;
  private readonly logger?: Logger;
  private readonly maxBufferedAmount: number;
  private readonly uiRequestTimeoutMs: number;

  private wss: WebSocketServer | null = null;
  private clients = new Map<string, ClientConnection>();
  private attachedClientId: string | null = null;
  private pendingUiRequests = new Map<string, NodeJS.Timeout>();

  constructor(options: WebSocketRpcBridgeOptions = {}) {
    this.options = options;
    this.logger = options.logger;
    this.maxBufferedAmount = options.maxBufferedAmount ?? DEFAULT_WS_MAX_BUFFERED_AMOUNT;
    this.uiRequestTimeoutMs = options.uiRequestTimeoutMs ?? DEFAULT_UI_REQUEST_TIMEOUT_MS;

    this.bindPiProcessEvents();
  }

  private bindPiProcessEvents(): void {
    const pi = this.options.piProcess;
    if (!pi) return;

    pi.on("event", (event: Record<string, unknown>) => {
      this.handlePiEvent(event);
    });
  }

  public attachServer(httpServer: http.Server): void {
    this.wss = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", (req, socket, head) => {
      const host = req.headers.host || "localhost";
      const url = new URL(req.url || "/", `http://${host}`);
      const pathname = url.pathname;

      if (pathname === "/v1/rpc" || pathname === "/ws/rpc") {
        this.handleUpgrade(req, socket, head);
      }
    });

    this.wss.on("connection", (ws, req) => {
      this.handleConnection(ws, req);
    });
  }

  public handleUpgrade(req: http.IncomingMessage, socket: stream.Duplex, head: Buffer): void {
    if (!this.wss) {
      socket.destroy();
      return;
    }

    const rawProtocols = req.headers["sec-websocket-protocol"];
    const requestedProtocols = (
      typeof rawProtocols === "string" ? rawProtocols.split(",") : []
    ).map((p) => p.trim());

    // Check matching subprotocol
    let selectedProtocol: string | undefined;
    for (const proto of requestedProtocols) {
      if (
        proto === "lambda-microvms" ||
        proto === "lambda-microvms.port.8080" ||
        proto.startsWith("lambda-microvms.authentication.")
      ) {
        selectedProtocol = proto;
        break;
      }
    }

    // Default fallback to first if requested
    if (!selectedProtocol && requestedProtocols.length > 0) {
      selectedProtocol = requestedProtocols[0];
    }

    this.wss.handleUpgrade(
      req,
      socket,
      head,
      (ws) => {
        this.wss?.emit("connection", ws, req);
      },
      // Note: ws handleUpgrade supports selected subprotocol via response headers or protocol argument
    );
  }

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const clientId = `ws-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const client: ClientConnection = {
      id: clientId,
      ws,
      isAttached: false,
      connectedAt: Date.now(),
    };

    this.clients.set(clientId, client);
    this.logger?.info?.(
      `WebSocket client connected: ${clientId} (${req.url}) [active: ${this.clients.size}]`,
    );

    ws.on("message", (data, isBinary) => {
      const text = isBinary ? data.toString() : data.toString("utf8");
      this.handleClientMessage(client, text);
    });

    const cleanup = () => {
      this.clients.delete(clientId);
      if (this.attachedClientId === clientId) {
        this.attachedClientId = null;
        this.logger?.info?.(`Attached WebSocket client ${clientId} disconnected`);
      }
      this.logger?.info?.(
        `WebSocket client disconnected: ${clientId} [active: ${this.clients.size}]`,
      );
    };

    ws.on("close", cleanup);
    ws.on("error", (err) => {
      this.logger?.warn?.(`WebSocket error on ${clientId}: ${err.message}`);
      cleanup();
    });
  }

  private handleClientMessage(client: ClientConnection, raw: string): void {
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        this.processClientCommand(client, msg);
      } catch (err) {
        this.logger?.warn?.(
          `Invalid JSON message from client ${client.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.sendToClient(client, {
          type: "error",
          error: {
            code: "INVALID_JSON",
            message: "Malformed JSON message frame",
          },
        });
      }
    }
  }

  private processClientCommand(client: ClientConnection, msg: Record<string, unknown>): void {
    const type = String(msg.type || "");
    const id = msg.id as string | undefined;

    // 1. Handle attach / detach
    if (type === "attach") {
      // Mark this client as attached
      for (const c of this.clients.values()) {
        c.isAttached = false;
      }
      client.isAttached = true;
      this.attachedClientId = client.id;
      this.logger?.info?.(`WebSocket client ${client.id} is now ATTACHED`);

      this.sendToClient(client, {
        id,
        type: "response",
        success: true,
        data: { attached: true, clientId: client.id },
      });
      return;
    }

    if (type === "detach") {
      client.isAttached = false;
      if (this.attachedClientId === client.id) {
        this.attachedClientId = null;
      }
      this.sendToClient(client, {
        id,
        type: "response",
        success: true,
        data: { attached: false },
      });
      return;
    }

    const pi = this.options.piProcess;
    if (!pi) {
      this.sendToClient(client, {
        id,
        type: "response",
        success: false,
        error: { message: "Pi process is not initialized" },
      });
      return;
    }

    // 2. Handle prompt / steer / follow_up
    if (type === "prompt" || type === "steer" || type === "follow_up") {
      const message = String(msg.message || msg.prompt || "");
      pi.prompt(message, type as "prompt" | "steer" | "follow_up")
        .then((result) => {
          this.sendToClient(client, {
            id,
            type: "response",
            success: true,
            data: result ?? { accepted: true },
          });
        })
        .catch((err) => {
          this.sendToClient(client, {
            id,
            type: "response",
            success: false,
            error: { message: err instanceof Error ? err.message : String(err) },
          });
        });
      return;
    }

    // 3. Handle abort
    if (type === "abort") {
      pi.abort()
        .then(() => {
          this.sendToClient(client, {
            id,
            type: "response",
            success: true,
            data: { aborted: true },
          });
        })
        .catch((err) => {
          this.sendToClient(client, {
            id,
            type: "response",
            success: false,
            error: { message: err instanceof Error ? err.message : String(err) },
          });
        });
      return;
    }

    // 4. Handle extension_ui_response
    if (type === "extension_ui_response") {
      const reqId = String(msg.requestId || msg.id || "");
      if (this.pendingUiRequests.has(reqId)) {
        clearTimeout(this.pendingUiRequests.get(reqId));
        this.pendingUiRequests.delete(reqId);
      }

      pi.sendRequest("extension_ui_response", msg)
        .then((result) => {
          this.sendToClient(client, {
            id,
            type: "response",
            success: true,
            data: result,
          });
        })
        .catch((err) => {
          this.sendToClient(client, {
            id,
            type: "response",
            success: false,
            error: { message: err instanceof Error ? err.message : String(err) },
          });
        });
      return;
    }

    // 5. Generic RPC forward
    pi.sendRequest(type, msg)
      .then((data) => {
        this.sendToClient(client, {
          id,
          type: "response",
          success: true,
          data,
        });
      })
      .catch((err) => {
        this.sendToClient(client, {
          id,
          type: "response",
          success: false,
          error: { message: err instanceof Error ? err.message : String(err) },
        });
      });
  }

  private handlePiEvent(event: Record<string, unknown>): void {
    const type = String(event.type || "");

    // Special handling for extension_ui_request
    if (type === "extension_ui_request") {
      this.handleExtensionUiRequest(event);
      return;
    }

    // Broadcast standard pi events to all connected clients with backpressure handling
    this.broadcast(event);
  }

  private handleExtensionUiRequest(event: Record<string, unknown>): void {
    const reqId = String(event.id || `ui-${Date.now()}`);

    const attachedClient = this.attachedClientId ? this.clients.get(this.attachedClientId) : null;

    if (attachedClient && attachedClient.ws.readyState === WebSocket.OPEN) {
      // Forward request to attached client
      this.sendToClient(attachedClient, event);

      // Set timeout for auto-cancellation after 120s if attached client doesn't reply
      const timer = setTimeout(() => {
        this.pendingUiRequests.delete(reqId);
        this.logger?.warn?.(
          `extension_ui_request '${reqId}' timed out after ${this.uiRequestTimeoutMs}ms. Auto-cancelling.`,
        );
        this.autoCancelUiRequest(reqId);
      }, this.uiRequestTimeoutMs);

      this.pendingUiRequests.set(reqId, timer);
    } else {
      // No attached client -> immediately auto-cancel
      this.logger?.warn?.(
        `Received extension_ui_request '${reqId}' but no client is attached. Auto-cancelling.`,
      );
      this.autoCancelUiRequest(reqId);
    }
  }

  private autoCancelUiRequest(reqId: string): void {
    const pi = this.options.piProcess;
    if (pi) {
      pi.sendRequest("extension_ui_response", {
        id: reqId,
        response: { action: "cancelled" },
      }).catch((err) => {
        this.logger?.warn?.(
          `Auto-cancel extension_ui_response failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  /**
   * Broadcasts a pi event to all connected clients.
   * Applies backpressure by dropping message_update delta frames for slow clients.
   */
  public broadcast(event: Record<string, unknown>): void {
    const type = String(event.type || "");
    const isDelta = type === "message_update" || type === "tool_execution_update";

    for (const client of this.clients.values()) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      if (isDelta && client.ws.bufferedAmount > this.maxBufferedAmount) {
        // Drop delta frame for slow client to protect memory
        this.logger?.warn?.(
          `Dropping delta frame '${type}' for slow WebSocket client ${client.id} (buffered: ${client.ws.bufferedAmount} bytes)`,
        );
        continue;
      }

      this.sendToClient(client, event);
    }
  }

  private sendToClient(client: ClientConnection, msg: Record<string, unknown>): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;

    try {
      const sanitized = redactObject(msg);
      const payload = `${JSON.stringify(sanitized)}\n`;
      client.ws.send(payload);
    } catch (err) {
      this.logger?.warn?.(
        `Failed to send frame to client ${client.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  public getConnectedClientsCount(): number {
    return this.clients.size;
  }

  public getAttachedClientId(): string | null {
    return this.attachedClientId;
  }

  public async close(): Promise<void> {
    for (const timer of this.pendingUiRequests.values()) {
      clearTimeout(timer);
    }
    this.pendingUiRequests.clear();

    for (const client of this.clients.values()) {
      try {
        client.ws.close(1000, "Server shutting down");
      } catch {
        // Ignore close error
      }
    }
    this.clients.clear();
    this.attachedClientId = null;

    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss?.close(() => resolve());
      });
      this.wss = null;
    }
  }
}
