/**
 * Unit tests for Hello MicroVM spike (T0.3).
 * Tests ZIP bundling, guest server generation, payload formation, cost calculation,
 * mock MicroVM server, proxy header validation, port 9000 403 isolation,
 * WebSocket echo, SSE heartbeat streaming, and simulated end-to-end execution.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildHelloBundleZip,
  generateDockerfile,
  generateServerJs,
  generateTestRunHookPayload,
} from "../../core/aws/hello-bundle.js";
import {
  calculateEstimatedCost,
  createMockMicrovmServer,
  formatHelloMicrovmReport,
  runHelloMicrovmSpike,
  runSseHeartbeatTest,
  runWebSocketEchoTest,
} from "../../core/aws/hello-microvm.js";
import { computeCrc32, createDeterministicZip } from "../../core/aws/zip.js";

describe("Deterministic ZIP Builder", () => {
  it("computes accurate CRC32 checksums", () => {
    const testData = Buffer.from("123456789", "utf-8");
    // Standard CRC32 check value for "123456789" is 0xcbf43926 (3421780262)
    const crc = computeCrc32(testData);
    expect(crc).toBe(0xcbf43926);
  });

  it("produces deterministic, byte-for-byte identical output for identical inputs", () => {
    const entries = [
      { name: "b.txt", content: "hello world" },
      { name: "a.txt", content: "alpha beta" },
    ];

    const zip1 = createDeterministicZip(entries);
    const zip2 = createDeterministicZip(entries);

    expect(zip1.length).toBeGreaterThan(0);
    expect(zip1.equals(zip2)).toBe(true);

    const hash1 = createHash("sha256").update(zip1).digest("hex");
    const hash2 = createHash("sha256").update(zip2).digest("hex");
    expect(hash1).toBe(hash2);
  });

  it("includes valid PKZIP signatures", () => {
    const zip = createDeterministicZip([{ name: "test.txt", content: "sample" }]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50); // Local header signature
  });
});

describe("Hello MicroVM Bundle Generation", () => {
  it("generates valid Dockerfile with required instructions", () => {
    const df = generateDockerfile();
    expect(df).toContain("FROM public.ecr.aws/lambda/microvms:al2023-minimal:latest");
    expect(df).toContain("EXPOSE 9000");
    expect(df).toContain("EXPOSE 8080");
    expect(df).toContain("CMD");
  });

  it("generates in-VM server.js listening on 9000 and 8080", () => {
    const serverJs = generateServerJs();
    expect(serverJs).toContain("0.0.0.0:9000");
    expect(serverJs).toContain("0.0.0.0:8080");
    expect(serverJs).toContain("/aws/lambda-microvms/runtime/v1/run");
    expect(serverJs).toContain("/sse");
    expect(serverJs).toContain("Sec-WebSocket-Accept");
  });

  it("builds deployment bundle ZIP containing Dockerfile and server.js", () => {
    const zip = buildHelloBundleZip();
    expect(zip.length).toBeGreaterThan(500);
    const zipStr = zip.toString("binary");
    expect(zipStr).toContain("Dockerfile");
    expect(zipStr).toContain("server.js");
  });

  it("generates target-sized ~3 KB JSON payload", () => {
    const target = 3072;
    const { payloadJson, payloadObject, sizeBytes } = generateTestRunHookPayload(target);
    expect(sizeBytes).toBe(target);
    expect(Buffer.byteLength(payloadJson, "utf-8")).toBe(target);
    expect(payloadObject.test).toBe("pi-cloud-agents hello-microvm");
    const parsed = JSON.parse(payloadJson);
    expect(parsed.config.provider).toBe("mock-provider");
  });
});

describe("AWS Cost Estimation", () => {
  it("calculates realistic MicroVM cost with snapshot storage and execution duration", () => {
    const cost = calculateEstimatedCost(10000, 2); // 10s run, 2 GB RAM
    expect(cost).toBeGreaterThan(0.01); // base snapshot read/write is ~$0.0138
    expect(cost).toBeLessThan(0.05);
  });
});

describe("Mock MicroVM Server & Protocol Validation", () => {
  it("enforces authentication and port isolation rules", async () => {
    const validToken = "test-auth-token-12345";
    const server = await createMockMicrovmServer({
      microvmId: "mvm-test-1",
      runHookPayload: JSON.stringify({ hello: "world" }),
      validToken,
    });

    try {
      const port = server.port;

      // 1. Missing token -> 401
      const resUnauth = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { "X-aws-proxy-port": "8080" },
      });
      expect(resUnauth.status).toBe(401);

      // 2. Port 9000 isolation -> 403 Forbidden
      const resPort9000 = await fetch(`http://127.0.0.1:${port}/`, {
        headers: {
          "X-aws-proxy-auth": validToken,
          "X-aws-proxy-port": "9000",
        },
      });
      expect(resPort9000.status).toBe(403);

      // 3. Valid port 8080 + auth -> 200 OK
      const resOk = await fetch(`http://127.0.0.1:${port}/`, {
        headers: {
          "X-aws-proxy-auth": validToken,
          "X-aws-proxy-port": "8080",
        },
      });
      expect(resOk.status).toBe(200);
      const json = (await resOk.json()) as Record<string, unknown>;
      expect(json.status).toBe("ok");
      expect(json.microvmId).toBe("mvm-test-1");
    } finally {
      await server.close();
    }
  });

  it("handles WebSocket echo with lambda-microvms subprotocols", async () => {
    const validToken = "test-ws-token-abc";
    const server = await createMockMicrovmServer({
      microvmId: "mvm-ws-test",
      runHookPayload: "test-payload",
      validToken,
    });

    try {
      const wsResult = await runWebSocketEchoTest({
        url: `ws://127.0.0.1:${server.port}/ws`,
        authToken: validToken,
        port: "8080",
        frameCount: 10,
        timeoutMs: 3000,
      });

      expect(wsResult.success).toBe(true);
      expect(wsResult.framesSent).toBe(10);
      expect(wsResult.framesReceived).toBe(10);
    } finally {
      await server.close();
    }
  });

  it("streams SSE heartbeat frames over HTTP", async () => {
    const validToken = "test-sse-token-xyz";
    const server = await createMockMicrovmServer({
      microvmId: "mvm-sse-test",
      runHookPayload: "test-payload",
      validToken,
    });

    try {
      const sseResult = await runSseHeartbeatTest({
        url: `http://127.0.0.1:${server.port}/sse`,
        authToken: validToken,
        port: "8080",
        minHeartbeats: 3,
        timeoutMs: 3000,
      });

      expect(sseResult.success).toBe(true);
      expect(sseResult.heartbeatsReceived).toBeGreaterThanOrEqual(3);
    } finally {
      await server.close();
    }
  });
});

describe("End-to-End Simulation Runner", () => {
  it("executes full simulated spike with all verifications and timings", async () => {
    const report = await runHelloMicrovmSpike({
      region: "us-east-1",
      simulate: true,
    });

    expect(report.mode).toBe("SIMULATED");
    expect(report.overallStatus).toBe("PASS");

    // Check all verifications
    expect(report.verifications.payloadEcho.status).toBe("PASS");
    expect(report.verifications.payloadEcho.matchesOriginal).toBe(true);
    expect(report.verifications.payloadEcho.sizeBytes).toBe(3072);

    expect(report.verifications.portIsolation.status).toBe("PASS");
    expect(report.verifications.portIsolation.statusCode).toBe(403);

    expect(report.verifications.webSocketEcho.status).toBe("PASS");
    expect(report.verifications.webSocketEcho.framesReceived).toBe(10);

    expect(report.verifications.sseHeartbeat.status).toBe("PASS");
    expect(report.verifications.sseHeartbeat.heartbeatsReceived).toBeGreaterThanOrEqual(3);

    expect(report.verifications.lifecycleResume.status).toBe("PASS");
    expect(report.verifications.lifecycleResume.postResumeHttp200).toBe(true);

    // Check timings presence
    expect(report.timings.imageBuildMs).toBeGreaterThan(0);
    expect(report.timings.runToRunningMs).toBeGreaterThan(0);
    expect(report.timings.firstHttp200Ms).toBeGreaterThan(0);
    expect(report.timings.suspendMs).toBeGreaterThan(0);
    expect(report.timings.resumeMs).toBeGreaterThan(0);
    expect(report.timings.terminateMs).toBeGreaterThan(0);
    expect(report.timings.totalMs).toBeGreaterThan(0);

    // Format output
    const formatted = formatHelloMicrovmReport(report);
    expect(formatted).toContain("Hello MicroVM Spike (T0.3) · us-east-1 (simulated)");
    expect(formatted).toContain("Payload Echo (3072 B)");
    expect(formatted).toContain("Port Isolation (port 9000 -> 403)");
    expect(formatted).toContain("WebSocket Echo (10/10 frames)");
    expect(formatted).toContain("Verdict: SUCCESS");
  });
});
