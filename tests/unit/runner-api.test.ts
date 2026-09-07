import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_API_BODY_BYTES, RunnerApiServer } from "../../runner/api.js";
import { PiProcessManager } from "../../runner/pi-process.js";
import { RunStateMachine } from "../../runner/state.js";
import { LocalStorageSink } from "../../runner/storage.js";
import type { LaunchPayload } from "../../shared/protocol.js";
import { ProtocolErrorCode, RunnerStatusSchema } from "../../shared/protocol.js";

const samplePayload: LaunchPayload = {
  v: 1,
  runId: "run-20260906-api01",
  owner: "user-ant",
  stack: {
    name: "pi-cloud-agents-core",
    region: "us-east-1",
    bucket: "test-bucket",
  },
  repo: {
    url: "https://github.com/example/repo.git",
    workBranch: "pi-cloud/run-api01",
  },
  model: {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
  },
  piConfig: {
    bundleKey: "bundles/b1.tar.gz",
    authParams: ["anthropic"],
    bedrockRole: false,
  },
  github: {
    mode: "none",
  },
  options: {
    installTimeoutSec: 60,
    trustProjectConfig: true,
    idleGraceSec: 300,
    suspendAfterIdleSec: 600,
    terminateAfterSuspendedSec: 1800,
    autoPush: true,
    maxDurationSec: 28800,
  },
  logGroup: "/aws/lambda/microvms/test-image",
};

describe("T2.5a Runner HTTP API (REST + SSE)", () => {
  let tmpDir: string;
  let sinkDir: string;
  let sessionDir: string;
  let server: RunnerApiServer;
  let port: number;
  let stateMachine: RunStateMachine;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cloud-api-test-"));
    sinkDir = path.join(tmpDir, "storage");
    sessionDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sinkDir, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });

    const storageSink = new LocalStorageSink({ baseDir: sinkDir });
    stateMachine = new RunStateMachine({
      payload: samplePayload,
      storageSink,
    });

    // Use random available port (port: 0)
    server = new RunnerApiServer({
      port: 0,
      runStateMachine: stateMachine,
      heartbeatIntervalMs: 50,
    });
    await server.listen();
    port = server.getPort();
  });

  afterEach(async () => {
    await server.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  async function request(
    method: string,
    reqPath: string,
    options: {
      body?: string | Buffer;
      headers?: Record<string, string>;
    } = {},
  ): Promise<{
    statusCode: number;
    headers: http.IncomingHttpHeaders;
    body: string;
    json: () => unknown;
  }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: reqPath,
          method,
          headers: options.headers || {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers,
              body,
              json: () => JSON.parse(body),
            });
          });
        },
      );

      req.on("error", reject);

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }

  it("GET /healthz returns 200 { status: 'ok' }", async () => {
    const res = await request("GET", "/healthz");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /v1/status returns validated RunnerStatus payload", async () => {
    const res = await request("GET", "/v1/status");
    expect(res.statusCode).toBe(200);
    const data = res.json();
    const validated = RunnerStatusSchema.parse(data);
    expect(validated.runId).toBe("run-20260906-api01");
    expect(validated.status).toBe("launching");
    expect(validated.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("GET /v1/manifest returns the current RunManifest", async () => {
    const res = await request("GET", "/v1/manifest");
    expect(res.statusCode).toBe(200);
    const manifest = res.json() as Record<string, unknown>;
    expect(manifest.runId).toBe("run-20260906-api01");
    expect(manifest.v).toBe(1);
    expect(manifest.owner).toBe("user-ant");
  });

  it("POST /v1/prompt handles prompt when idle, rejects with 409 when busy streaming", async () => {
    // 1. Idle prompt accepted
    const idleRes = await request("POST", "/v1/prompt", {
      body: JSON.stringify({ prompt: "Refactor database module" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(idleRes.statusCode).toBe(200);
    expect(idleRes.json()).toEqual({ status: "accepted", mode: "prompt" });

    // 2. Set streaming mode active
    server.setStreaming(true);

    // 3. Prompt without steer returns 409 Conflict
    const busyRes = await request("POST", "/v1/prompt", {
      body: JSON.stringify({ prompt: "Another prompt" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(busyRes.statusCode).toBe(409);
    const busyError = busyRes.json() as { error: { code: string; message: string } };
    expect(busyError.error.code).toBe(ProtocolErrorCode.CONFLICT);
    expect(busyError.error.message).toContain("steer");

    // 4. Steer mode while busy returns 200 accepted
    const steerRes = await request("POST", "/v1/prompt", {
      body: JSON.stringify({ prompt: "Stop and focus on X", mode: "steer" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(steerRes.statusCode).toBe(200);
    expect(steerRes.json()).toEqual({ status: "accepted", mode: "steer" });

    // 5. FollowUp mode while busy returns 200 accepted (supports both followUp and follow_up)
    const followUpRes = await request("POST", "/v1/prompt", {
      body: JSON.stringify({ message: "Also run tests", mode: "followUp" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(followUpRes.statusCode).toBe(200);
    expect(followUpRes.json()).toEqual({ status: "accepted", mode: "followUp" });

    const followUpSnakeRes = await request("POST", "/v1/prompt", {
      body: JSON.stringify({ message: "Also run tests snake_case", mode: "follow_up" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(followUpSnakeRes.statusCode).toBe(200);
    expect(followUpSnakeRes.json()).toEqual({ status: "accepted", mode: "follow_up" });
  });

  it("POST /v1/prompt validates request schema and rejects bad input", async () => {
    // Missing prompt and message
    const badRes = await request("POST", "/v1/prompt", {
      body: JSON.stringify({ mode: "prompt" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(badRes.statusCode).toBe(400);
    const err = badRes.json() as { error: { code: string } };
    expect(err.error.code).toBe(ProtocolErrorCode.INVALID_PAYLOAD);

    // Invalid JSON
    const malformedRes = await request("POST", "/v1/prompt", {
      body: "{ not json }",
      headers: { "Content-Type": "application/json" },
    });
    expect(malformedRes.statusCode).toBe(400);
  });

  it("POST /v1/abort and POST /v1/interrupt return 200", async () => {
    const abortRes = await request("POST", "/v1/abort", {
      body: JSON.stringify({ reason: "User cancelled" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(abortRes.statusCode).toBe(200);

    const interruptRes = await request("POST", "/v1/interrupt");
    expect(interruptRes.statusCode).toBe(200);
  });

  it("POST /v1/checkpoint flushes session and records timeline", async () => {
    const res = await request("POST", "/v1/checkpoint");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "checkpointed" });

    const manifest = stateMachine.getManifest();
    expect(manifest.timeline.some((t) => t.status === "checkpoint")).toBe(true);
  });

  it("POST /v1/finalize and POST /v1/shutdown trigger handlers", async () => {
    let finalized = false;
    let shutDown = false;

    await server.close();
    server = new RunnerApiServer({
      port: 0,
      runStateMachine: stateMachine,
      onFinalize: async (req) => {
        finalized = true;
        expect(req.autoPush).toBe(true);
      },
      onShutdown: async () => {
        shutDown = true;
      },
    });
    await server.listen();
    port = server.getPort();

    const finRes = await request("POST", "/v1/finalize", {
      body: JSON.stringify({ autoPush: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect(finRes.statusCode).toBe(200);
    expect(finRes.json()).toEqual({ status: "finalizing" });
    expect(finalized).toBe(true);

    const shutRes = await request("POST", "/v1/shutdown");
    expect(shutRes.statusCode).toBe(200);
    expect(shutRes.json()).toEqual({ status: "shutting_down" });
    expect(shutDown).toBe(true);
  });

  it("GET /v1/entries retrieves historical session entries and filters with since", async () => {
    const sessionFilePath = path.join(sessionDir, "test-session.jsonl");
    fs.writeFileSync(
      sessionFilePath,
      `${JSON.stringify({ id: "e1", type: "session_start" })}\n${JSON.stringify({ id: "e2", type: "message_start" })}\n${JSON.stringify({ id: "e3", type: "message_end" })}\n`,
      "utf8",
    );

    await server.close();
    server = new RunnerApiServer({
      port: 0,
      runStateMachine: stateMachine,
      getHistoricalEntries: async (sinceId) => {
        const entries = [
          { id: "e1", type: "session_start" },
          { id: "e2", type: "message_start" },
          { id: "e3", type: "message_end" },
        ];
        if (!sinceId) return entries;
        const idx = entries.findIndex((e) => e.id === sinceId);
        return idx !== -1 ? entries.slice(idx + 1) : entries;
      },
    });
    await server.listen();
    port = server.getPort();

    // All entries
    const allRes = await request("GET", "/v1/entries");
    expect(allRes.statusCode).toBe(200);
    const allEntries = allRes.json() as Array<{ id: string }>;
    expect(allEntries.length).toBe(3);

    // Filtered entries
    const filteredRes = await request("GET", "/v1/entries?since=e1");
    expect(filteredRes.statusCode).toBe(200);
    const filteredEntries = filteredRes.json() as Array<{ id: string }>;
    expect(filteredEntries.length).toBe(2);
    expect(filteredEntries[0]?.id).toBe("e2");
  });

  it("GET /v1/events handles SSE streaming, historical replay, and heartbeats", async () => {
    await server.close();

    const fakePiScript = path.resolve(__dirname, "../fakes/fake-pi.ts");
    const fakeRepoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(fakeRepoDir, { recursive: true });

    const piProc = new PiProcessManager({
      workingDirectory: fakeRepoDir,
      sessionDir,
      piBinary: fakePiScript,
    });
    await piProc.start();

    server = new RunnerApiServer({
      port: 0,
      runStateMachine: stateMachine,
      piProcess: piProc,
      heartbeatIntervalMs: 30, // Fast heartbeat for test
      getHistoricalEntries: async (sinceId) => {
        const entries: Array<Record<string, unknown>> = [
          { id: "entry-0", type: "historical_start" },
          { id: "entry-1", type: "historical_msg" },
        ];
        if (sinceId === "entry-0") {
          return entries.slice(1);
        }
        return entries;
      },
    });
    await server.listen();
    port = server.getPort();

    const sseFrames: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/v1/events?since=entry-0",
          method: "GET",
          headers: {
            Accept: "text/event-stream",
          },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers["content-type"]).toContain("text/event-stream");

          res.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            sseFrames.push(text);

            const accumulated = sseFrames.join("");
            if (accumulated.includes(": heartbeat") && accumulated.includes("historical_msg")) {
              req.destroy();
              resolve();
            }
          });
        },
      );

      req.on("error", (err) => {
        if ((err as { code?: string }).code === "ECONNRESET") {
          resolve();
        } else {
          reject(err);
        }
      });

      req.end();
    });

    await piProc.stop();

    const fullSse = sseFrames.join("");
    expect(fullSse).toContain("id: entry-1");
    expect(fullSse).toContain("event: historical_msg");
    expect(fullSse).toContain(": heartbeat");
  });

  it("enforces 1 MB request body limit with 413 Payload Too Large", async () => {
    // Generate payload larger than 1 MB
    const largeBuffer = Buffer.alloc(MAX_API_BODY_BYTES + 1024, "a");

    const res = await request("POST", "/v1/prompt", {
      body: largeBuffer,
      headers: { "Content-Type": "application/json" },
    });

    expect(res.statusCode).toBe(413);
    const err = res.json() as { error: { code: string; message: string } };
    expect(err.error.code).toBe(ProtocolErrorCode.PAYLOAD_TOO_LARGE);
  });

  it("returns 404 for unknown endpoints", async () => {
    const res = await request("GET", "/v1/nonexistent");
    expect(res.statusCode).toBe(404);
    const err = res.json() as { error: { code: string } };
    expect(err.error.code).toBe(ProtocolErrorCode.NOT_FOUND);
  });
});
