import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunnerApiServer } from "../../runner/api.js";
import { MetricsCollector } from "../../runner/metrics.js";
import { PiProcessManager } from "../../runner/pi-process.js";
import { RunStateMachine } from "../../runner/state.js";
import { LocalStorageSink } from "../../runner/storage.js";
import type { LaunchPayload } from "../../shared/protocol.js";

const samplePayload: LaunchPayload = {
  v: 1,
  runId: "run-20260906-met01",
  owner: "user-ant",
  stack: {
    name: "pi-cloud-agents-core",
    region: "us-east-1",
    bucket: "test-bucket",
  },
  repo: {
    url: "https://github.com/example/repo.git",
    workBranch: "pi-cloud/run-met01",
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
    autoPush: false,
    maxDurationSec: 28800,
  },
  logGroup: "/aws/lambda/microvms/test-image",
};

describe("T2.10 Runner Metrics & Observability Timeline", () => {
  let tmpDir: string;
  let sinkDir: string;
  let sessionDir: string;
  let repoDir: string;
  let simulatedTime: number;

  const fakeClock = () => simulatedTime;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cloud-met-test-"));
    sinkDir = path.join(tmpDir, "storage");
    sessionDir = path.join(tmpDir, "sessions");
    repoDir = path.join(tmpDir, "repo");

    fs.mkdirSync(sinkDir, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });

    simulatedTime = 1788733200000;
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("records lifecycle milestones and calculates launchToReady duration", () => {
    const storageSink = new LocalStorageSink({ baseDir: sinkDir });
    const stateMachine = new RunStateMachine({
      payload: samplePayload,
      storageSink,
    });

    const metrics = new MetricsCollector(stateMachine, undefined, {
      clock: fakeClock,
    });

    // Initial launch milestone at t=0
    metrics.recordMilestone("secrets", simulatedTime + 500, 500);
    metrics.recordMilestone("clone", simulatedTime + 2000, 1500);
    metrics.recordMilestone("install", simulatedTime + 10000, 8000);

    // Ready at t=12000ms
    simulatedTime += 12000;
    metrics.recordMilestone("ready", simulatedTime);

    const full = metrics.getFullMetrics();
    expect(full.lifecycle.launchToReadyMs).toBe(12000);
    expect(full.lifecycle.milestones.length).toBeGreaterThanOrEqual(4);
  });

  it("tracks tool call counters and active currentTool duration", () => {
    const fakePiScript = path.resolve(__dirname, "../fakes/fake-pi.ts");
    const piProcess = new PiProcessManager({
      workingDirectory: repoDir,
      sessionDir,
      piBinary: fakePiScript,
    });

    const metrics = new MetricsCollector(undefined, piProcess, {
      clock: fakeClock,
    });

    // 1. Tool execution start: bash
    piProcess.emit("tool_execution_start", { toolName: "bash" });
    simulatedTime += 5000;

    let current = metrics.getFullMetrics().agent.currentTool;
    expect(current?.name).toBe("bash");
    expect(current?.elapsedMs).toBe(5000);

    // Tool execution end
    piProcess.emit("tool_execution_end");
    current = metrics.getFullMetrics().agent.currentTool;
    expect(current).toBeUndefined();

    // 2. Tool execution start: edit
    piProcess.emit("tool_execution_start", { toolName: "edit" });
    piProcess.emit("tool_execution_end");

    // 3. Tool execution start: bash again
    piProcess.emit("tool_execution_start", { toolName: "bash" });
    piProcess.emit("tool_execution_end");

    const agent = metrics.getFullMetrics().agent;
    expect(agent.toolCallsTotal).toBe(3);
    expect(agent.toolCalls.bash).toBe(2);
    expect(agent.toolCalls.edit).toBe(1);
  });

  it("measures TTFT (Time-To-First-Token) and turn duration", () => {
    const fakePiScript = path.resolve(__dirname, "../fakes/fake-pi.ts");
    const piProcess = new PiProcessManager({
      workingDirectory: repoDir,
      sessionDir,
      piBinary: fakePiScript,
    });

    const metrics = new MetricsCollector(undefined, piProcess, {
      clock: fakeClock,
    });

    // Turn 1: start at t=0, first token at t=800ms, turn end at t=3500ms
    piProcess.emit("turn_start");
    simulatedTime += 800;
    piProcess.emit("message_update", { content: [{ type: "text", text: "Hello" }] });
    simulatedTime += 2700;
    piProcess.emit("turn_end");

    // Turn 2: start, first token at t=1200ms, turn end at t=4000ms
    simulatedTime += 1000;
    piProcess.emit("turn_start");
    simulatedTime += 1200;
    piProcess.emit("message_update", { content: [{ type: "text", text: "World" }] });
    simulatedTime += 2800;
    piProcess.emit("turn_end");

    const model = metrics.getFullMetrics().model;
    expect(model.ttft?.lastMs).toBe(1200);
    expect(model.ttft?.avgMs).toBe(1000); // (800 + 1200) / 2 = 1000

    expect(model.turnDuration?.lastMs).toBe(4000);
    expect(model.turnDuration?.avgMs).toBe(3750); // (3500 + 4000) / 2 = 3750
  });

  it("samples VM system resources into ring buffer without fabricated data", async () => {
    const metrics = new MetricsCollector(undefined, undefined, {
      clock: fakeClock,
      workPath: tmpDir,
    });

    const sample = await metrics.sampleVmResources();
    expect(sample).toBeDefined();
    expect(sample?.at).toBeDefined();

    // Verify measurable fields exist and are real numbers
    if (sample?.load1m !== undefined) {
      expect(typeof sample.load1m).toBe("number");
      expect(sample.load1m).toBeGreaterThanOrEqual(0);
    }
    if (sample?.memTotalMb !== undefined) {
      expect(sample.memTotalMb).toBeGreaterThan(0);
      expect(sample.memUsedMb).toBeGreaterThanOrEqual(0);
    }

    const full = metrics.getFullMetrics();
    expect(full.vm.history.length).toBe(1);
    expect(full.vm.latest).toBeDefined();
  });

  it("tracks events per minute series for dashboard sparkline", () => {
    const fakePiScript = path.resolve(__dirname, "../fakes/fake-pi.ts");
    const piProcess = new PiProcessManager({
      workingDirectory: repoDir,
      sessionDir,
      piBinary: fakePiScript,
    });

    const metrics = new MetricsCollector(undefined, piProcess, {
      clock: fakeClock,
    });

    // Emit 5 events in minute 0
    for (let i = 0; i < 5; i++) {
      piProcess.emit("event", { type: "test" });
    }

    // Advance clock 2 minutes
    simulatedTime += 2 * 60000;

    // Emit 10 events in minute 2
    for (let i = 0; i < 10; i++) {
      piProcess.emit("event", { type: "test" });
    }

    const series = metrics.getEventRateSeries();
    expect(series.length).toBe(30);
    expect(series[series.length - 1]).toBe(10); // current minute (minute 2)
    expect(series[series.length - 3]).toBe(5); // 2 minutes ago (minute 0)
  });

  it("integrates with RunnerApiServer to serve GET /v1/metrics", async () => {
    const storageSink = new LocalStorageSink({ baseDir: sinkDir });
    const stateMachine = new RunStateMachine({
      payload: samplePayload,
      storageSink,
    });

    const metrics = new MetricsCollector(stateMachine, undefined, {
      clock: fakeClock,
      payload: samplePayload,
    });

    metrics.setTokenUsage({
      input: 120000,
      output: 15000,
      total: 135000,
      estimatedCostUsd: 0.65,
    });

    const server = new RunnerApiServer({
      port: 0,
      runStateMachine: stateMachine,
      metricsCollector: metrics,
    });
    await server.listen();
    const port = server.getPort();

    const res = await new Promise<{ statusCode: number; data: Record<string, unknown> }>(
      (resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/v1/metrics`, (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => {
            resolve({
              statusCode: r.statusCode || 0,
              data: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          });
          r.on("error", reject);
        });
      },
    );

    expect(res.statusCode).toBe(200);
    expect(res.data.runId).toBe("run-20260906-met01");
    expect((res.data.model as { tokens: { total: number } })?.tokens?.total).toBe(135000);
    expect(
      (res.data.model as { tokens: { estimatedCostUsd: number } })?.tokens?.estimatedCostUsd,
    ).toBe(0.65);

    await server.close();
  });
});
