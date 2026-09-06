/**
 * Unit tests for T2.1 MicroVM Lifecycle Hook Server.
 * Tests readiness 503/200 matrix, self-check validate 200/503,
 * /run payload validation & latency < 200ms, suspend/resume/terminate bounded deadlines,
 * idempotency, and unknown route resilience.
 */

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_PATH_PREFIX, LifecycleHookServer } from "../../runner/hooks.js";
import {
  type LaunchPayload,
  ProtocolErrorCode,
  encodeLaunchPayload,
} from "../../shared/protocol.js";

const samplePayload: LaunchPayload = {
  v: 1,
  runId: "run-20260906-hookstest",
  owner: "arn:aws:iam::123456789012:user/alice",
  stack: {
    name: "pi-cloud-agents-core",
    region: "us-east-1",
    bucket: "pi-cloud-agents-core-runs-123456789012",
  },
  repo: {
    url: "https://github.com/example/repo.git",
    ref: "main",
    workBranch: "pi-cloud/run-20260906-hookstest",
  },
  model: {
    provider: "anthropic",
    id: "claude-sonnet-4-20250514",
    thinking: {
      budgetTokens: 1024,
    },
  },
  piConfig: {
    bundleKey: "config/alice/bundle.tar",
    authParams: ["anthropic"],
    bedrockRole: false,
  },
  github: {
    mode: "secret",
    name: "pi-cloud-agents/pi-cloud-agents-core/github/token",
  },
  options: {
    installTimeoutSec: 120,
    trustProjectConfig: true,
    idleGraceSec: 60,
    suspendAfterIdleSec: 300,
    terminateAfterSuspendedSec: 3600,
    autoPush: true,
    maxDurationSec: 7200,
  },
  logGroup: "/aws/lambda/microvms/pi-cloud-agents-runner",
};

/** Helper to make HTTP requests against a local port. */
async function sendRequest(
  port: number,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: Record<string, unknown>; elapsedMs: number }> {
  const method = options.method || "GET";
  const postData = options.body ? JSON.stringify(options.body) : undefined;
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(postData
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData),
              }
            : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const elapsedMs = Date.now() - startTime;
          const raw = Buffer.concat(chunks).toString("utf8");
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(raw);
          } catch {
            body = { raw };
          }
          resolve({
            status: res.statusCode || 0,
            body,
            elapsedMs,
          });
        });
      },
    );

    req.on("error", (err) => reject(err));
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

describe("T2.1 Lifecycle Hook Server", () => {
  let server: LifecycleHookServer;
  let port: number;

  beforeEach(async () => {
    server = new LifecycleHookServer({
      port: 0, // dynamic port for tests
      host: "127.0.0.1",
    });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe("Readiness Hook (GET /ready)", () => {
    it("returns 503 when server is not initialized", async () => {
      expect(server.isReady()).toBe(false);

      const res = await sendRequest(port, `${HOOK_PATH_PREFIX}/ready`);
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("initializing");
    });

    it("returns 200 once server is set to ready", async () => {
      server.setReady(true);
      expect(server.isReady()).toBe(true);

      const res = await sendRequest(port, `${HOOK_PATH_PREFIX}/ready`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ready");
    });

    it("handles short alias route /ready", async () => {
      server.setReady(true);
      const res = await sendRequest(port, "/ready");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ready");
    });
  });

  describe("Validation Hook (GET/POST /validate)", () => {
    it("runs default self check and returns 200 on healthy system", async () => {
      const res = await sendRequest(port, `${HOOK_PATH_PREFIX}/validate`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("valid");
      expect(res.body.details).toBeDefined();
    });

    it("returns 503 when custom validateSelfCheck fails", async () => {
      const customServer = new LifecycleHookServer({
        port: 0,
        host: "127.0.0.1",
        validateSelfCheck: () => ({
          ok: false,
          message: "Pi binary missing",
          details: { pi: null },
        }),
      });
      const customPort = await customServer.start();

      try {
        const res = await sendRequest(customPort, `${HOOK_PATH_PREFIX}/validate`, {
          method: "GET",
        });
        expect(res.status).toBe(503);
        expect(res.body.status).toBe("invalid");
        expect(res.body.error).toBe("Pi binary missing");
      } finally {
        await customServer.stop();
      }
    });

    it("returns 503 when validateSelfCheck throws an unhandled error", async () => {
      const customServer = new LifecycleHookServer({
        port: 0,
        host: "127.0.0.1",
        validateSelfCheck: () => {
          throw new Error("Disk inspection crashed");
        },
      });
      const customPort = await customServer.start();

      try {
        const res = await sendRequest(customPort, `${HOOK_PATH_PREFIX}/validate`, {
          method: "POST",
        });
        expect(res.status).toBe(503);
        expect(res.body.status).toBe("invalid");
        expect(res.body.error).toContain("Disk inspection crashed");
      } finally {
        await customServer.stop();
      }
    });
  });

  describe("Run Hook (POST /run)", () => {
    it("responds with 200 in < 200ms with valid LaunchPayload and triggers onRun async", async () => {
      let onRunCalledWith: unknown = null;

      const runServer = new LifecycleHookServer({
        port: 0,
        host: "127.0.0.1",
        onRun: (data) => {
          onRunCalledWith = data;
        },
      });
      const runPort = await runServer.start();

      try {
        const rawPayload = encodeLaunchPayload(samplePayload);
        const res = await sendRequest(runPort, `${HOOK_PATH_PREFIX}/run`, {
          method: "POST",
          body: {
            microvmId: "microvm-test-1234",
            runHookPayload: rawPayload,
          },
        });

        expect(res.status).toBe(200);
        expect(res.elapsedMs).toBeLessThan(200);
        expect(res.body.status).toBe("accepted");
        expect(res.body.runId).toBe("run-20260906-hookstest");

        // Wait a microtask tick for async onRun
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(onRunCalledWith).not.toBeNull();
        const runData = onRunCalledWith as {
          microvmId: string;
          payload: LaunchPayload;
          error?: Error;
        };
        expect(runData.microvmId).toBe("microvm-test-1234");
        expect(runData.payload.runId).toBe("run-20260906-hookstest");
        expect(runData.error).toBeUndefined();
      } finally {
        await runServer.stop();
      }
    });

    it("responds with 200 fast (< 200ms) on invalid payload and passes error to onRun", async () => {
      let onRunCalledWith: unknown = null;

      const runServer = new LifecycleHookServer({
        port: 0,
        host: "127.0.0.1",
        onRun: (data) => {
          onRunCalledWith = data;
        },
      });
      const runPort = await runServer.start();

      try {
        const res = await sendRequest(runPort, `${HOOK_PATH_PREFIX}/run`, {
          method: "POST",
          body: {
            microvmId: "microvm-test-invalid",
            runHookPayload: '{"v": 999, "corrupt": true}',
          },
        });

        expect(res.status).toBe(200);
        expect(res.elapsedMs).toBeLessThan(200);
        expect(res.body.status).toBe("accepted");
        expect(res.body.warning).toBe("invalid_payload");
        expect(res.body.code).toBe(ProtocolErrorCode.INVALID_PAYLOAD);

        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(onRunCalledWith).not.toBeNull();
        const runData = onRunCalledWith as {
          microvmId: string;
          payload: LaunchPayload | null;
          error?: Error;
        };
        expect(runData.microvmId).toBe("microvm-test-invalid");
        expect(runData.payload).toBeNull();
        expect(runData.error).toBeDefined();
      } finally {
        await runServer.stop();
      }
    });

    it("handles duplicate /run calls cleanly with idempotency flag", async () => {
      const rawPayload = encodeLaunchPayload(samplePayload);
      const res1 = await sendRequest(port, `${HOOK_PATH_PREFIX}/run`, {
        method: "POST",
        body: {
          microvmId: "microvm-1",
          runHookPayload: rawPayload,
        },
      });
      expect(res1.status).toBe(200);
      expect(res1.body.duplicate).toBe(false);

      const res2 = await sendRequest(port, `${HOOK_PATH_PREFIX}/run`, {
        method: "POST",
        body: {
          microvmId: "microvm-1",
          runHookPayload: rawPayload,
        },
      });
      expect(res2.status).toBe(200);
      expect(res2.body.duplicate).toBe(true);
    });
  });

  describe("Resume Hook (POST /resume)", () => {
    it("executes onResume and returns 200", async () => {
      let resumed = false;
      const resumeServer = new LifecycleHookServer({
        port: 0,
        host: "127.0.0.1",
        onResume: () => {
          resumed = true;
        },
      });
      const resumePort = await resumeServer.start();

      try {
        const res = await sendRequest(resumePort, `${HOOK_PATH_PREFIX}/resume`, {
          method: "POST",
        });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("ok");
        expect(res.body.action).toBe("resume");
        expect(resumed).toBe(true);
      } finally {
        await resumeServer.stop();
      }
    });

    it("returns 200 even if onResume throws an error", async () => {
      const resumeServer = new LifecycleHookServer({
        port: 0,
        host: "127.0.0.1",
        onResume: () => {
          throw new Error("Failed to reconnect socket pool");
        },
      });
      const resumePort = await resumeServer.start();

      try {
        const res = await sendRequest(resumePort, `${HOOK_PATH_PREFIX}/resume`, {
          method: "POST",
        });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("ok");
      } finally {
        await resumeServer.stop();
      }
    });

    it("returns 200 within bounded deadline even if onResume hangs", async () => {
      const resumeServer = new LifecycleHookServer({
        port: 0,
        host: "127.0.0.1",
        timeouts: {
          resume: 50, // 50ms test timeout
        },
        onResume: async () => {
          await new Promise((resolve) => setTimeout(resolve, 500)); // Hanger
        },
      });
      const resumePort = await resumeServer.start();

      try {
        const res = await sendRequest(resumePort, `${HOOK_PATH_PREFIX}/resume`, {
          method: "POST",
        });
        expect(res.status).toBe(200);
        expect(res.elapsedMs).toBeLessThan(200);
      } finally {
        await resumeServer.stop();
      }
    });
  });

  describe("Suspend Hook (POST /suspend)", () => {
    it("executes onSuspend and returns 200", async () => {
      let suspended = false;
      const suspendServer = new LifecycleHookServer({
        port: 0,
        host: "127.0.0.1",
        onSuspend: () => {
          suspended = true;
        },
      });
      const suspendPort = await suspendServer.start();

      try {
        const res = await sendRequest(suspendPort, `${HOOK_PATH_PREFIX}/suspend`, {
          method: "POST",
        });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("ok");
        expect(res.body.action).toBe("suspend");
        expect(suspended).toBe(true);
      } finally {
        await suspendServer.stop();
      }
    });

    it("returns 200 even if onSuspend hangs past deadline", async () => {
      const suspendServer = new LifecycleHookServer({
        port: 0,
        host: "127.0.0.1",
        timeouts: {
          suspend: 60, // 60ms deadline
        },
        onSuspend: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        },
      });
      const suspendPort = await suspendServer.start();

      try {
        const res = await sendRequest(suspendPort, `${HOOK_PATH_PREFIX}/suspend`, {
          method: "POST",
        });
        expect(res.status).toBe(200);
        expect(res.elapsedMs).toBeLessThan(250);
      } finally {
        await suspendServer.stop();
      }
    });
  });

  describe("Terminate Hook (POST /terminate)", () => {
    it("executes onTerminate and returns 200", async () => {
      let terminated = false;
      const termServer = new LifecycleHookServer({
        port: 0,
        host: "127.0.0.1",
        onTerminate: () => {
          terminated = true;
        },
      });
      const termPort = await termServer.start();

      try {
        const res = await sendRequest(termPort, `${HOOK_PATH_PREFIX}/terminate`, {
          method: "POST",
        });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("ok");
        expect(res.body.action).toBe("terminate");
        expect(terminated).toBe(true);
      } finally {
        await termServer.stop();
      }
    });

    it("returns 200 even if onTerminate throws or hangs", async () => {
      const termServer = new LifecycleHookServer({
        port: 0,
        host: "127.0.0.1",
        timeouts: {
          terminate: 50,
        },
        onTerminate: async () => {
          throw new Error("S3 flush failed");
        },
      });
      const termPort = await termServer.start();

      try {
        const res = await sendRequest(termPort, `${HOOK_PATH_PREFIX}/terminate`, {
          method: "POST",
        });
        expect(res.status).toBe(200);
      } finally {
        await termServer.stop();
      }
    });
  });

  describe("Unknown Hook Routes & Fallbacks", () => {
    it("returns 200 on unknown hook routes under prefix", async () => {
      const res = await sendRequest(port, `${HOOK_PATH_PREFIX}/unknown_hook_route`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.path).toBe(`${HOOK_PATH_PREFIX}/unknown_hook_route`);
    });

    it("returns 200 on root and other unknown paths", async () => {
      const res = await sendRequest(port, "/random-path");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });
  });
});
