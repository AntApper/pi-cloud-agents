/**
 * Dev Client for pi-cloud-agents (T2.8).
 * Subscribes to SSE event stream, submits prompts, streams events to console/collector,
 * awaits agent settlement, and issues finalize / shutdown calls.
 */

import http from "node:http";

export interface SseClientEvent {
  type: string;
  data: unknown;
  timestamp?: string;
  eventId?: string;
}

export interface ClientRunOptions {
  apiPort?: number;
  host?: string;
  prompt?: string;
  timeoutMs?: number;
  onEvent?: (event: SseClientEvent) => void;
  verbose?: boolean;
}

export interface ClientRunResult {
  success: boolean;
  events: SseClientEvent[];
  settledStatus?: string;
  error?: string;
  durationMs: number;
}

/**
 * Runs a full client interaction turn against the runner API.
 */
export async function runClientTurn(options: ClientRunOptions = {}): Promise<ClientRunResult> {
  const host = options.host ?? "127.0.0.1";
  const port = options.apiPort ?? 8080;
  const promptText = options.prompt ?? "Create hello.txt using bash and report done";
  const timeoutMs = options.timeoutMs ?? 30000;
  const verbose = options.verbose ?? false;

  const events: SseClientEvent[] = [];
  const startTime = Date.now();

  return new Promise<ClientRunResult>((resolve) => {
    let resolved = false;
    let sseReq: http.ClientRequest | null = null;

    const finish = (result: Partial<ClientRunResult>) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);

      if (sseReq) {
        try {
          sseReq.destroy();
        } catch {}
      }

      resolve({
        success: result.success ?? false,
        events,
        settledStatus: result.settledStatus,
        error: result.error,
        durationMs: Date.now() - startTime,
      });
    };

    const timer = setTimeout(() => {
      finish({
        success: false,
        error: `Client turn timed out after ${timeoutMs}ms waiting for agent_settled`,
      });
    }, timeoutMs);

    // 1. Connect to SSE stream
    sseReq = http.request(
      {
        hostname: host,
        port,
        path: "/v1/events",
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          finish({
            success: false,
            error: `SSE stream request failed with status ${res.statusCode}`,
          });
          return;
        }

        let buffer = "";

        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");

          // SSE format: event: <type>\ndata: <json>\n\n
          while (true) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary === -1) break;

            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);

            const lines = block.split("\n");
            let eventType = "message";
            let dataStr = "";

            for (const line of lines) {
              if (line.startsWith("event:")) {
                eventType = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                dataStr = line.slice(5).trim();
              }
            }

            if (dataStr) {
              try {
                const parsed = JSON.parse(dataStr);
                const event: SseClientEvent = {
                  type: (parsed.type || eventType) as string,
                  data: parsed.data ?? parsed,
                  timestamp: parsed.timestamp ?? new Date().toISOString(),
                  eventId: parsed.eventId,
                };

                events.push(event);
                options.onEvent?.(event);

                if (verbose) {
                  console.log(`[SSE] ${event.type}:`, JSON.stringify(event.data));
                }

                // Check for agent settlement
                if (
                  event.type === "agent_settled" ||
                  (event.data as { status?: string })?.status === "idle"
                ) {
                  const status = (event.data as { status?: string })?.status ?? "idle";
                  // Allow short grace for final flushes
                  setTimeout(() => {
                    finish({ success: true, settledStatus: status });
                  }, 100);
                }
              } catch {
                // Ignore invalid SSE frame format
              }
            }
          }
        });

        res.on("error", (err) => {
          if (!resolved) {
            finish({ success: false, error: `SSE stream error: ${err.message}` });
          }
        });
      },
    );

    sseReq.on("error", (err) => {
      finish({ success: false, error: `Failed to connect to SSE stream: ${err.message}` });
    });

    sseReq.end();

    // 2. Submit prompt after SSE connection starts
    setTimeout(async () => {
      if (resolved) return;
      try {
        await postJson(host, port, "/v1/prompt", {
          prompt: promptText,
        });
        if (verbose) {
          console.log(`Submitted prompt: "${promptText}"`);
        }
      } catch (err) {
        finish({
          success: false,
          error: `Failed to submit prompt: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }, 200);
  });
}

/**
 * Sends POST /v1/finalize request.
 */
export async function finalizeRun(
  port = 8080,
  host = "127.0.0.1",
  status = "completed",
  message = "Run finished successfully",
): Promise<void> {
  await postJson(host, port, "/v1/finalize", { status, message });
}

/**
 * Sends POST /v1/shutdown request.
 */
export async function shutdownRunner(port = 8080, host = "127.0.0.1"): Promise<void> {
  await postJson(host, port, "/v1/shutdown", {});
}

/**
 * Helper to execute HTTP POST with JSON body.
 */
function postJson(
  host: string,
  port: number,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const postData = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: host,
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch {
              resolve({});
            }
          } else {
            reject(new Error(`POST ${path} returned status ${res.statusCode}: ${data}`));
          }
        });
      },
    );

    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// CLI entrypoint
if (
  process.argv[1] &&
  (process.argv[1].endsWith("client.ts") || process.argv[1].endsWith("client.js"))
) {
  const port = process.env.APP_PORT ? Number(process.env.APP_PORT) : 8080;
  console.log(`Connecting client to runner on port ${port}...`);

  runClientTurn({ apiPort: port, verbose: true })
    .then(async (result) => {
      console.log("Turn result:", result.success ? "SUCCESS" : "FAILED");
      console.log(`Events received: ${result.events.length}`);
      if (result.error) console.error(`Error: ${result.error}`);

      console.log("Sending finalize...");
      await finalizeRun(port);
      console.log("Sending shutdown...");
      await shutdownRunner(port);
      console.log("Client done.");
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error("Client error:", err);
      process.exit(1);
    });
}
