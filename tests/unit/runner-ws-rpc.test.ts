import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RunnerApiServer } from "../../runner/api.js";
import { PiProcessManager } from "../../runner/pi-process.js";
import { RunStateMachine } from "../../runner/state.js";
import { LocalStorageSink } from "../../runner/storage.js";
import { WebSocketRpcBridge } from "../../runner/ws-rpc.js";
import type { LaunchPayload } from "../../shared/protocol.js";

const samplePayload: LaunchPayload = {
  v: 1,
  runId: "run-20260906-ws01",
  owner: "user-ant",
  stack: {
    name: "pi-cloud-agents-core",
    region: "us-east-1",
    bucket: "test-bucket",
  },
  repo: {
    url: "https://github.com/example/repo.git",
    workBranch: "pi-cloud/run-ws01",
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

describe("T2.5b Runner WebSocket RPC Passthrough", () => {
  let tmpDir: string;
  let sinkDir: string;
  let sessionDir: string;
  let server: RunnerApiServer;
  let port: number;
  let piProcess: PiProcessManager;
  let stateMachine: RunStateMachine;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cloud-ws-test-"));
    sinkDir = path.join(tmpDir, "storage");
    sessionDir = path.join(tmpDir, "sessions");
    const repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(sinkDir, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });

    const fakePiScript = path.resolve(__dirname, "../fakes/fake-pi.ts");
    piProcess = new PiProcessManager({
      workingDirectory: repoDir,
      sessionDir,
      piBinary: fakePiScript,
    });
    await piProcess.start();

    const storageSink = new LocalStorageSink({ baseDir: sinkDir });
    stateMachine = new RunStateMachine({
      payload: samplePayload,
      storageSink,
    });

    server = new RunnerApiServer({
      port: 0,
      runStateMachine: stateMachine,
      piProcess,
    });
    await server.listen();
    port = server.getPort();
  });

  afterEach(async () => {
    await server.close();
    await piProcess.stop();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  function connectWs(pathName = "/v1/rpc", subprotocols?: string[]): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${pathName}`, subprotocols);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  function waitForMessage<T = Record<string, unknown>>(
    ws: WebSocket,
    predicate: (msg: T) => boolean,
    timeoutMs = 3000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off("message", handler);
        reject(new Error(`Timed out waiting for WebSocket message after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (data: Buffer | string) => {
        const text = typeof data === "string" ? data : data.toString("utf8");
        const lines = text.split("\n").filter((l) => l.trim().length > 0);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as T;
            if (predicate(parsed)) {
              clearTimeout(timer);
              ws.off("message", handler);
              resolve(parsed);
              return;
            }
          } catch {
            // Ignore malformed line
          }
        }
      };

      ws.on("message", handler);
    });
  }

  it("handles WebSocket connection and subprotocol handshake", async () => {
    const ws = await connectWs("/v1/rpc", [
      "lambda-microvms",
      "lambda-microvms.port.8080",
      "lambda-microvms.authentication.tok123",
    ]);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("fans out pi events to multiple concurrent WebSocket clients", async () => {
    const client1 = await connectWs("/v1/rpc");
    const client2 = await connectWs("/ws/rpc");

    const client1Events: string[] = [];
    const client2Events: string[] = [];

    client1.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type) client1Events.push(msg.type);
    });

    client2.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type) client2Events.push(msg.type);
    });

    // Send prompt via client1 and wait for agent_settled on both clients
    const promptPromise1 = waitForMessage(
      client1,
      (m: Record<string, unknown>) => m.type === "agent_settled",
    );
    const promptPromise2 = waitForMessage(
      client2,
      (m: Record<string, unknown>) => m.type === "agent_settled",
    );

    client1.send(
      `${JSON.stringify({
        id: "req-p1",
        type: "prompt",
        message: "Hello fanout",
      })}\n`,
    );

    await Promise.all([promptPromise1, promptPromise2]);

    // Both clients must receive broadcasted events
    expect(client1Events).toContain("turn_start");
    expect(client1Events).toContain("message_start");
    expect(client1Events).toContain("agent_settled");

    expect(client2Events).toContain("turn_start");
    expect(client2Events).toContain("message_start");
    expect(client2Events).toContain("agent_settled");

    client1.close();
    client2.close();
  });

  it("tracks attached client and routes extension_ui_request", async () => {
    const bridge = server.getWsBridge();

    const client1 = await connectWs();
    const client2 = await connectWs();

    // Attach client2
    const attachPromise = waitForMessage(
      client2,
      (m: Record<string, unknown>) =>
        m.type === "response" && (m.data as { attached?: boolean })?.attached === true,
    );
    client2.send(`${JSON.stringify({ id: "att-1", type: "attach" })}\n`);
    await attachPromise;

    expect(bridge.getAttachedClientId()).toBeDefined();

    // Simulate extension_ui_request event from pi process
    const uiReqPromise = waitForMessage(
      client2,
      (m: Record<string, unknown>) => m.type === "extension_ui_request",
    );

    piProcess.emit("event", {
      type: "extension_ui_request",
      id: "ui-req-99",
      method: "confirm",
      params: { message: "Proceed with deletion?" },
    });

    const receivedUiReq = await uiReqPromise;
    expect(receivedUiReq.id).toBe("ui-req-99");

    // Client2 responds to UI request
    client2.send(
      `${JSON.stringify({
        id: "resp-99",
        type: "extension_ui_response",
        requestId: "ui-req-99",
        response: { confirmed: true },
      })}\n`,
    );

    client1.close();
    client2.close();
  });

  it("auto-cancels extension_ui_request when no client is attached or on timeout", async () => {
    let autoCancelled = false;

    // Listen on piProcess for the auto-cancelled response
    piProcess.sendRequest = async <T = unknown>(
      type: string,
      payload: Record<string, unknown> = {},
    ): Promise<T> => {
      if (type === "extension_ui_response") {
        if ((payload.response as { action?: string })?.action === "cancelled") {
          autoCancelled = true;
        }
      }
      return { ok: true } as T;
    };

    // Emit UI request with no attached client
    piProcess.emit("event", {
      type: "extension_ui_request",
      id: "ui-unattached-1",
      method: "confirm",
      params: { message: "Are you sure?" },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(autoCancelled).toBe(true);
  });

  it("handles backpressure by dropping delta frames for slow clients", async () => {
    const bridge = new WebSocketRpcBridge({
      piProcess,
      maxBufferedAmount: 10, // Very low threshold to trigger drop
    });

    let droppedEventReceived = false;
    let terminalEventReceived = false;

    // Create a mock client with simulated bufferedAmount
    const mockWs = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 100, // Exceeds maxBufferedAmount (10)
      send: (data: string) => {
        if (data.includes("message_update")) {
          droppedEventReceived = true;
        }
        if (data.includes("agent_settled")) {
          terminalEventReceived = true;
        }
      },
    } as unknown as WebSocket;

    // Simulate connection
    (bridge as unknown as { clients: Map<string, { id: string; ws: WebSocket }> }).clients.set(
      "slow-client",
      {
        id: "slow-client",
        ws: mockWs,
      },
    );

    // Broadcast delta frame -> should be dropped
    bridge.broadcast({
      type: "message_update",
      id: "msg-1",
      content: [{ type: "text", text: "delta" }],
    });

    // Broadcast terminal frame -> must NEVER be dropped
    bridge.broadcast({
      type: "agent_settled",
      status: "idle",
    });

    expect(droppedEventReceived).toBe(false);
    expect(terminalEventReceived).toBe(true);

    await bridge.close();
  });

  it("handles client disconnection cleanly", async () => {
    const client = await connectWs();
    expect(server.getWsBridge().getConnectedClientsCount()).toBe(1);

    client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(server.getWsBridge().getConnectedClientsCount()).toBe(0);
  });
});
