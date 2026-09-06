/**
 * MicroVM Run Client (T4.5).
 * Implements token minting and caching with T-5m auto-refresh,
 * HTTP REST wrapper with 403 refresh and 502 auto-resume backoff,
 * SSE event stream consumer with cursor-based reconnection,
 * WebSocket RPC client with subprotocol negotiation,
 * and periodic keepalive / RTT polling per ADR-4.
 */

import {
  CreateMicrovmAuthTokenCommand,
  type LambdaMicrovmsClient,
} from "@aws-sdk/client-lambda-microvms";
import { WebSocket as WsWebSocket } from "ws";
import {
  type FinalizeRequest,
  type PromptRequest,
  ProtocolHeaders,
  type RunManifest,
  RunManifestSchema,
  type RunnerStatus,
  RunnerStatusSchema,
  type SseEnvelope,
} from "../../shared/protocol.js";
import { AwsClientFactory } from "../aws/clients.js";

export const DEFAULT_PROXY_PORT = 8080;
export const DEFAULT_TOKEN_EXPIRATION_MINUTES = 30;
export const DEFAULT_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes (T-5 min)
export const DEFAULT_RESUME_TIMEOUT_MS = 60000; // 60 seconds
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 60000; // 60 seconds

export interface RunClientOptions {
  endpoint: string;
  microvmIdentifier?: string;
  region?: string;
  profile?: string;
  microvmsClient?: LambdaMicrovmsClient;
  clientFactory?: AwsClientFactory;
  token?: string;
  directHttp?: boolean;
  tokenExpirationMinutes?: number;
  refreshBufferMs?: number;
  resumeTimeoutMs?: number;
  fetchFn?: typeof fetch;
  WebSocketClass?: typeof WebSocket | typeof WsWebSocket;
}

export interface SseSubscribeOptions {
  cursor?: string;
  onEvent?: (event: SseEnvelope) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
  onSettled?: (status: string) => void;
  signal?: AbortSignal;
  autoReconnect?: boolean;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

export interface SseSubscription {
  unsubscribe: () => void;
  getLastCursor: () => string | undefined;
}

export interface WebSocketRpcOptions {
  clientId?: string;
  onEvent?: (event: Record<string, unknown>) => void;
  onUiRequest?: (request: Record<string, unknown>) => void;
  onError?: (err: Error) => void;
  onClose?: (code: number, reason: string) => void;
  onOpen?: () => void;
}

export class RunClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunClientError";
  }
}

export class RunClientHttpError extends RunClientError {
  readonly statusCode: number;
  readonly statusText: string;
  readonly bodyText?: string;
  readonly parsedError?: Record<string, unknown>;

  constructor(
    statusCode: number,
    statusText: string,
    bodyText?: string,
    parsedError?: Record<string, unknown>,
  ) {
    const errorMsg =
      (parsedError?.error as { message?: string })?.message ||
      (parsedError?.message as string) ||
      bodyText ||
      statusText;
    super(`HTTP ${statusCode} ${statusText}: ${errorMsg}`);
    this.name = "RunClientHttpError";
    this.statusCode = statusCode;
    this.statusText = statusText;
    this.bodyText = bodyText;
    this.parsedError = parsedError;
  }
}

export interface WebSocketRpcClient {
  ws: WebSocket | WsWebSocket;
  send(data: Record<string, unknown>): void;
  prompt(promptText: string): void;
  steer(steerText: string): void;
  followUp(followUpText: string): void;
  abort(): void;
  attach(clientId?: string): void;
  detach(): void;
  extensionUiResponse(id: string, response: unknown): void;
  close(code?: number, reason?: string): void;
}

/**
 * Client for interacting with an AWS Lambda MicroVM runner instance.
 */
export class RunClient {
  private readonly options: RunClientOptions;
  private readonly clientFactory: AwsClientFactory;
  private readonly fetchFn: typeof fetch;
  private readonly webSocketClass: typeof WebSocket | typeof WsWebSocket;

  private cachedToken: string | null = null;
  private cachedTokenExpiresAt = 0;
  private tokenRefreshPromise: Promise<string> | null = null;

  constructor(options: RunClientOptions) {
    this.options = { ...options };
    this.clientFactory = options.clientFactory ?? new AwsClientFactory();
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.webSocketClass =
      options.WebSocketClass ??
      (globalThis.WebSocket as unknown as typeof WsWebSocket) ??
      WsWebSocket;

    if (options.token) {
      this.cachedToken = options.token;
      this.cachedTokenExpiresAt =
        Date.now() +
        (options.tokenExpirationMinutes ?? DEFAULT_TOKEN_EXPIRATION_MINUTES) * 60 * 1000;
    }
  }

  /**
   * Resolves the full HTTP(S) base URL for the runner API.
   */
  public getBaseUrl(): string {
    const endpoint = this.options.endpoint.trim();
    if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
      return endpoint.replace(/\/+$/, "");
    }
    if (endpoint.startsWith("localhost") || endpoint.startsWith("127.0.0.1")) {
      return `http://${endpoint}`.replace(/\/+$/, "");
    }
    return `https://${endpoint}`.replace(/\/+$/, "");
  }

  /**
   * Resolves the WebSocket base URL for the runner RPC bridge.
   */
  public getWebSocketUrl(path = "/v1/rpc"): string {
    const baseUrl = this.getBaseUrl();
    const wsBase = baseUrl.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://");
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    return `${wsBase}${cleanPath}`;
  }

  /**
   * Retrieves or auto-refreshes the proxy auth token.
   * Auto-refreshes when within refreshBufferMs (default 5 minutes) of expiration.
   */
  public async getAuthToken(forceRefresh = false): Promise<string> {
    if (this.options.directHttp) {
      return "";
    }

    const refreshBufferMs = this.options.refreshBufferMs ?? DEFAULT_REFRESH_BUFFER_MS;
    const now = Date.now();

    if (!forceRefresh && this.cachedToken && now < this.cachedTokenExpiresAt - refreshBufferMs) {
      return this.cachedToken;
    }

    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise;
    }

    this.tokenRefreshPromise = (async () => {
      try {
        const microvmId = this.options.microvmIdentifier;
        if (!microvmId) {
          if (this.cachedToken) return this.cachedToken;
          throw new RunClientError("microvmIdentifier is required to mint proxy auth tokens");
        }

        const microvmsClient =
          this.options.microvmsClient ??
          this.clientFactory.getLambdaMicrovmsClient({
            region: this.options.region,
            profile: this.options.profile,
          });

        const expirationMinutes =
          this.options.tokenExpirationMinutes ?? DEFAULT_TOKEN_EXPIRATION_MINUTES;
        const res = await microvmsClient.send(
          new CreateMicrovmAuthTokenCommand({
            microvmIdentifier: microvmId,
            expirationInMinutes: expirationMinutes,
            allowedPorts: [{ port: DEFAULT_PROXY_PORT }],
          }),
        );

        const tokenMap = res.authToken ?? {};
        const proxyToken =
          tokenMap["X-aws-proxy-auth"] ||
          tokenMap["x-aws-proxy-auth"] ||
          Object.values(tokenMap)[0];

        if (!proxyToken) {
          throw new RunClientError(
            "Failed to extract X-aws-proxy-auth from CreateMicrovmAuthToken response",
          );
        }

        this.cachedToken = proxyToken;
        this.cachedTokenExpiresAt = Date.now() + expirationMinutes * 60 * 1000;
        return proxyToken;
      } finally {
        this.tokenRefreshPromise = null;
      }
    })();

    return this.tokenRefreshPromise;
  }

  /**
   * Performs an HTTP request against the runner API with proxy headers,
   * 403 token auto-refresh, and 502 auto-resume exponential backoff.
   */
  public async request(path: string, init: RequestInit = {}): Promise<Response> {
    const baseUrl = this.getBaseUrl();
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    const url = `${baseUrl}${cleanPath}`;
    const resumeTimeoutMs = this.options.resumeTimeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS;
    const startTime = Date.now();

    let attempt = 0;
    let retried403 = false;

    while (true) {
      const token = await this.getAuthToken();
      const headers = new Headers(init.headers);

      if (token) {
        headers.set(ProtocolHeaders.PROXY_AUTH, token);
      }
      headers.set(ProtocolHeaders.PROXY_PORT, String(DEFAULT_PROXY_PORT));

      if (init.body && !headers.has("content-type") && typeof init.body === "string") {
        headers.set("content-type", "application/json");
      }

      try {
        const res = await this.fetchFn(url, {
          ...init,
          headers,
        });

        // 1. Handle 403 Forbidden -> Token expired or invalid, re-mint once and retry
        if (
          res.status === 403 &&
          !retried403 &&
          !this.options.directHttp &&
          this.options.microvmIdentifier
        ) {
          retried403 = true;
          await this.getAuthToken(true);
          continue;
        }

        // 2. Handle 502 Bad Gateway -> MicroVM is auto-resuming from SUSPENDED (ADR-4)
        if (res.status === 502) {
          const elapsed = Date.now() - startTime;
          if (elapsed < resumeTimeoutMs) {
            attempt++;
            const baseDelay = Math.min(500 * 1.5 ** attempt, 4000);
            const jitter = (Math.random() * 0.4 - 0.2) * baseDelay;
            const delay = Math.max(100, Math.round(baseDelay + jitter));
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(delay, resumeTimeoutMs - elapsed)),
            );
            continue;
          }
        }

        return res;
      } catch (err: unknown) {
        // Network errors during resume may happen before proxy responds
        const elapsed = Date.now() - startTime;
        if (elapsed < resumeTimeoutMs) {
          attempt++;
          const baseDelay = Math.min(500 * 1.5 ** attempt, 4000);
          const delay = Math.max(100, Math.round(baseDelay));
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(delay, resumeTimeoutMs - elapsed)),
          );
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Performs an HTTP request and parses JSON body, throwing RunClientHttpError on non-2xx status.
   */
  public async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init);
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // not JSON
    }

    if (!res.ok) {
      throw new RunClientHttpError(
        res.status,
        res.statusText,
        text,
        json && typeof json === "object" ? (json as Record<string, unknown>) : undefined,
      );
    }

    return json as T;
  }

  /**
   * Retrieves runner status from GET /v1/status.
   */
  public async getStatus(): Promise<RunnerStatus> {
    const json = await this.requestJson<unknown>("/v1/status");
    return RunnerStatusSchema.parse(json);
  }

  /**
   * Retrieves current run manifest from GET /v1/manifest.
   */
  public async getManifest(): Promise<RunManifest> {
    const json = await this.requestJson<unknown>("/v1/manifest");
    return RunManifestSchema.parse(json);
  }

  /**
   * Retrieves runner metrics from GET /v1/metrics.
   */
  public async getMetrics(): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>("/v1/metrics");
  }

  /**
   * Sends user prompt, steer, or follow-up to POST /v1/prompt.
   */
  public async prompt(req: PromptRequest): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>("/v1/prompt", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  /**
   * Sends interrupt signal to POST /v1/interrupt.
   */
  public async interrupt(reason?: string): Promise<{ aborted: boolean }> {
    return this.requestJson<{ aborted: boolean }>("/v1/interrupt", {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  }

  /**
   * Sends abort signal to POST /v1/abort.
   */
  public async abort(reason?: string): Promise<{ aborted: boolean }> {
    return this.requestJson<{ aborted: boolean }>("/v1/abort", {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  }

  /**
   * Triggers session checkpoint on POST /v1/checkpoint.
   */
  public async checkpoint(): Promise<{ status: string }> {
    return this.requestJson<{ status: string }>("/v1/checkpoint", {
      method: "POST",
    });
  }

  /**
   * Finalizes the run on POST /v1/finalize.
   */
  public async finalize(req?: FinalizeRequest): Promise<{ status: string }> {
    return this.requestJson<{ status: string }>("/v1/finalize", {
      method: "POST",
      body: JSON.stringify(req ?? {}),
    });
  }

  /**
   * Shuts down the runner on POST /v1/shutdown.
   */
  public async shutdown(): Promise<{ status: string }> {
    return this.requestJson<{ status: string }>("/v1/shutdown", {
      method: "POST",
    });
  }

  /**
   * Fetches historical session entries since an entry ID from GET /v1/entries.
   */
  public async getHistoricalEntries(sinceId?: string): Promise<Record<string, unknown>[]> {
    const q = sinceId ? `?since=${encodeURIComponent(sinceId)}` : "";
    const res = await this.requestJson<{ entries: Record<string, unknown>[] }>(`/v1/entries${q}`);
    return res.entries ?? [];
  }

  /**
   * Subscribes to Server-Sent Events (SSE) from GET /v1/events with cursor tracking and auto-reconnect.
   */
  public subscribeEvents(options: SseSubscribeOptions = {}): SseSubscription {
    let active = true;
    let abortController = new AbortController();
    let currentCursor = options.cursor;
    const autoReconnect = options.autoReconnect ?? true;
    let retryDelay = options.initialRetryDelayMs ?? 500;
    const maxRetryDelay = options.maxRetryDelayMs ?? 10000;

    const cleanup = () => {
      active = false;
      try {
        abortController.abort();
      } catch {}
    };

    if (options.signal) {
      options.signal.addEventListener("abort", cleanup, { once: true });
    }

    const runLoop = async () => {
      while (active) {
        if (options.signal?.aborted) {
          active = false;
          break;
        }

        abortController = new AbortController();
        const combinedSignal = abortController.signal;

        try {
          const path = currentCursor
            ? `/v1/events?since=${encodeURIComponent(currentCursor)}`
            : "/v1/events";
          const headers: Record<string, string> = {
            accept: "text/event-stream",
            "cache-control": "no-cache",
          };
          if (currentCursor) {
            headers[ProtocolHeaders.LAST_EVENT_ID] = currentCursor;
          }

          const res = await this.request(path, {
            headers,
            signal: combinedSignal,
          });

          if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new RunClientHttpError(res.status, res.statusText, body);
          }

          retryDelay = options.initialRetryDelayMs ?? 500; // Reset retry delay on successful connect

          if (!res.body) {
            throw new RunClientError("Response body is empty for SSE stream");
          }

          // Read stream using Web Streams reader
          const reader = res.body.getReader();
          const decoder = new TextDecoder("utf-8");
          let buffer = "";

          let eventId: string | undefined;
          let eventType = "message";
          let eventDataLines: string[] = [];

          const dispatchEvent = () => {
            if (eventDataLines.length === 0 && !eventId) return;

            const dataStr = eventDataLines.join("\n");
            let parsedData: unknown = dataStr;
            try {
              parsedData = JSON.parse(dataStr);
            } catch {
              // keep as string
            }

            const envelope: SseEnvelope = {
              id: eventId || `evt-${Date.now()}`,
              type: eventType || "message",
              data: parsedData,
            };

            if (eventId) {
              currentCursor = eventId;
            }

            options.onEvent?.(envelope);

            if (
              envelope.type === "agent_settled" &&
              typeof envelope.data === "object" &&
              envelope.data !== null
            ) {
              const settledStatus = (envelope.data as { status?: string }).status || "idle";
              options.onSettled?.(settledStatus);
            }

            // Reset parser fields
            eventId = undefined;
            eventType = "message";
            eventDataLines = [];
          };

          while (active) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trimEnd();
              if (trimmed === "") {
                // Empty line denotes end of an SSE message block
                dispatchEvent();
                continue;
              }

              if (trimmed.startsWith(":")) {
                // SSE comment / heartbeat
                continue;
              }

              if (trimmed.startsWith("id:")) {
                eventId = trimmed.slice(3).trim();
              } else if (trimmed.startsWith("event:")) {
                eventType = trimmed.slice(6).trim();
              } else if (trimmed.startsWith("data:")) {
                eventDataLines.push(trimmed.slice(5).trimStart());
              }
            }
          }

          // Handle leftover buffer if stream closed cleanly
          dispatchEvent();
        } catch (err: unknown) {
          if (!active || options.signal?.aborted) {
            break;
          }

          const error = err instanceof Error ? err : new Error(String(err));
          options.onError?.(error);
        }

        if (!active || !autoReconnect || options.signal?.aborted) {
          break;
        }

        // Backoff before reconnecting
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 1.5, maxRetryDelay);
      }

      options.onClose?.();
    };

    // Start background stream consumer
    void runLoop();

    return {
      unsubscribe: cleanup,
      getLastCursor: () => currentCursor,
    };
  }

  /**
   * Connects to the runner WebSocket RPC endpoint with standard subprotocols.
   */
  public async connectWebSocketRpc(options: WebSocketRpcOptions = {}): Promise<WebSocketRpcClient> {
    const token = await this.getAuthToken();
    const wsUrl = this.getWebSocketUrl("/v1/rpc");

    const protocols: string[] = ["lambda-microvms"];
    if (token) {
      protocols.push(`lambda-microvms.authentication.${token}`);
    }
    protocols.push(`lambda-microvms.port.${DEFAULT_PROXY_PORT}`);

    const WsCtor = this.webSocketClass;
    const ws = new WsCtor(wsUrl, protocols);

    const send = (data: Record<string, unknown>) => {
      const payload = `${JSON.stringify(data)}\n`;
      if ("send" in ws && typeof ws.send === "function") {
        ws.send(payload);
      }
    };

    const client: WebSocketRpcClient = {
      ws,
      send,
      prompt: (text: string) => send({ type: "prompt", prompt: text }),
      steer: (text: string) => send({ type: "steer", steer: text }),
      followUp: (text: string) => send({ type: "follow_up", prompt: text }),
      abort: () => send({ type: "abort" }),
      attach: (clientId?: string) =>
        send({ type: "attach", clientId: clientId ?? options.clientId }),
      detach: () => send({ type: "detach" }),
      extensionUiResponse: (id: string, response: unknown) =>
        send({ type: "extension_ui_response", id, response }),
      close: (code?: number, reason?: string) => {
        if ("close" in ws && typeof ws.close === "function") {
          ws.close(code, reason);
        }
      },
    };

    const handleMessage = (data: unknown) => {
      try {
        const rawStr =
          typeof data === "string" ? data : (data as Buffer | Uint8Array).toString("utf-8");
        const lines = rawStr.split("\n").filter((l) => l.trim().length > 0);
        for (const line of lines) {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          options.onEvent?.(parsed);

          if (parsed.type === "extension_ui_request") {
            options.onUiRequest?.(parsed);
          }
        }
      } catch (err) {
        options.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };

    if ("on" in ws && typeof (ws as unknown as { on: unknown }).on === "function") {
      const nodeWs = ws as unknown as {
        on(event: string, cb: (...args: unknown[]) => void): void;
      };
      nodeWs.on("open", () => options.onOpen?.());
      nodeWs.on("message", (data: unknown) => handleMessage(data));
      nodeWs.on("error", (err: unknown) =>
        options.onError?.(err instanceof Error ? err : new Error(String(err))),
      );
      nodeWs.on("close", (code: unknown, reason: unknown) => {
        const codeNum = typeof code === "number" ? code : 1000;
        const reasonStr = reason ? reason.toString() : "";
        options.onClose?.(codeNum, reasonStr);
      });
    } else {
      const genericWs = ws as unknown as {
        onopen: (() => void) | null;
        onmessage: ((event: { data: unknown }) => void) | null;
        onerror: ((error: unknown) => void) | null;
        onclose: ((event: { code: number; reason: string }) => void) | null;
      };
      genericWs.onopen = () => options.onOpen?.();
      genericWs.onmessage = (event: { data: unknown }) => handleMessage(event.data);
      genericWs.onerror = () => options.onError?.(new Error("WebSocket encountered error"));
      genericWs.onclose = (event: { code: number; reason: string }) =>
        options.onClose?.(event.code, event.reason);
    }

    return client;
  }

  /**
   * Starts periodic keepalive polling against GET /v1/status every intervalMs (default 60s).
   * Measures RTT and generates inbound keepalive traffic per ADR-4.
   * Returns a stop callback.
   */
  public startKeepalive(
    intervalMs = DEFAULT_KEEPALIVE_INTERVAL_MS,
    onPing?: (rttMs: number, status: RunnerStatus) => void,
  ): () => void {
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;

    const ping = async () => {
      if (stopped) return;
      const t0 = Date.now();
      try {
        const status = await this.getStatus();
        const rttMs = Date.now() - t0;
        if (!stopped) {
          onPing?.(rttMs, status);
        }
      } catch {
        // Keepalive error ignored
      } finally {
        if (!stopped) {
          timer = setTimeout(ping, intervalMs);
        }
      }
    };

    timer = setTimeout(ping, intervalMs);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }
}
