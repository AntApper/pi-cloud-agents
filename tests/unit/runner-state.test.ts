import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InvalidStateTransitionError,
  RunStateMachine,
  createInitialManifest,
} from "../../runner/state.js";
import { FakeStorageSink, LocalStorageSink } from "../../runner/storage.js";
import type { LaunchPayload } from "../../shared/protocol.js";

describe("T2.6 Run State Machine and Persistence", () => {
  let tempBaseDir: string;
  let sink: LocalStorageSink;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cloud-state-test-"));
    sink = new LocalStorageSink({ baseDir: tempBaseDir });
  });

  afterEach(() => {
    if (fs.existsSync(tempBaseDir)) {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    }
  });

  function createTestPayload(overrides?: Partial<LaunchPayload>): LaunchPayload {
    return {
      v: 1,
      runId: "run-20260906-state01",
      owner: "ant",
      stack: {
        name: "pi-cloud-agents-test",
        region: "us-east-1",
        bucket: "pi-cloud-test-bucket",
      },
      repo: {
        url: "https://github.com/example/test-repo.git",
        ref: "main",
        workBranch: "pi-cloud/run-state01",
      },
      model: {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
      },
      piConfig: {
        bundleKey: "config/bundle.tar",
        authParams: ["anthropic"],
        bedrockRole: false,
      },
      github: {
        mode: "none",
      },
      options: {
        installTimeoutSec: 60,
        trustProjectConfig: true,
        idleGraceSec: 60,
        suspendAfterIdleSec: 300,
        terminateAfterSuspendedSec: 600,
        autoPush: true,
        maxDurationSec: 3600,
      },
      logGroup: "/aws/lambda-microvms/pi-cloud-agents-runner",
      ...overrides,
    };
  }

  it("initializes RunManifest from LaunchPayload correctly", () => {
    const payload = createTestPayload();
    const manifest = createInitialManifest(payload, {
      imageVersion: "1.2.0",
      microvmId: "mvm-12345",
      endpoint: "https://mvm-12345.lambda-microvms.us-east-1.on.aws",
    });

    expect(manifest.v).toBe(1);
    expect(manifest.runId).toBe("run-20260906-state01");
    expect(manifest.status).toBe("launching");
    expect(manifest.imageVersion).toBe("1.2.0");
    expect(manifest.microvmId).toBe("mvm-12345");
    expect(manifest.endpoint).toBe("https://mvm-12345.lambda-microvms.us-east-1.on.aws");
    expect(manifest.timeline.length).toBe(1);
    expect(manifest.timeline[0]?.status).toBe("launching");
  });

  it("follows valid lifecycle state transitions", async () => {
    const payload = createTestPayload();
    const sm = new RunStateMachine({
      payload,
      storageSink: sink,
    });

    expect(sm.getStatus()).toBe("launching");

    // launching -> running
    await sm.transitionTo("running", "Workspace initialized and ready");
    expect(sm.getStatus()).toBe("running");

    // running -> idle
    await sm.transitionTo("idle", "Agent settled waiting for prompt");
    expect(sm.getStatus()).toBe("idle");

    // idle -> suspended
    await sm.transitionTo("suspended", "External idle threshold reached");
    expect(sm.getStatus()).toBe("suspended");

    // suspended -> running
    await sm.transitionTo("running", "Resumed by incoming prompt");
    expect(sm.getStatus()).toBe("running");

    // running -> completed
    await sm.transitionTo("completed", "Task finished successfully");
    expect(sm.getStatus()).toBe("completed");

    // Verify timeline records each transition
    const manifest = sm.getManifest();
    expect(manifest.timeline.length).toBe(6);
    expect(manifest.timeline.map((t) => t.status)).toEqual([
      "launching",
      "running",
      "idle",
      "suspended",
      "running",
      "completed",
    ]);

    // Verify manifest was saved to storage sink
    const storedManifestBuf = await sink.getObject("runs/run-20260906-state01/manifest.json");
    const storedManifest = JSON.parse(storedManifestBuf.toString("utf8"));
    expect(storedManifest.status).toBe("completed");
  });

  it("rejects illegal state transitions and throws InvalidStateTransitionError", async () => {
    const payload = createTestPayload();
    const sm = new RunStateMachine({
      payload,
      storageSink: sink,
    });

    // launching cannot transition directly to idle (must be running first)
    await expect(sm.transitionTo("idle")).rejects.toThrow(InvalidStateTransitionError);

    // transition to running
    await sm.transitionTo("running");

    // transition to completed (terminal state)
    await sm.transitionTo("completed");

    // completed cannot transition back to running
    await expect(sm.transitionTo("running")).rejects.toThrow(InvalidStateTransitionError);

    // completed cannot transition to suspended
    await expect(sm.transitionTo("suspended")).rejects.toThrow(InvalidStateTransitionError);
  });

  it("tracks token usage and updates git metadata", async () => {
    const payload = createTestPayload();
    const sm = new RunStateMachine({
      payload,
      storageSink: sink,
    });

    await sm.transitionTo("running");

    await sm.updateUsage({
      inputTokens: 1250,
      outputTokens: 420,
      estimatedCostUsd: 0.015,
    });

    expect(sm.getManifest().usage?.totalTokens).toBe(1670);
    expect(sm.getManifest().usage?.inputTokens).toBe(1250);
    expect(sm.getManifest().usage?.outputTokens).toBe(420);
    expect(sm.getManifest().usage?.estimatedCostUsd).toBe(0.015);

    await sm.updateGit({
      lastCommit: "a1b2c3d4e5f6",
      prUrl: "https://github.com/example/test-repo/pull/42",
    });

    expect(sm.getManifest().git?.lastCommit).toBe("a1b2c3d4e5f6");
    expect(sm.getManifest().git?.prUrl).toBe("https://github.com/example/test-repo/pull/42");

    sm.recordLastEntryId("entry-msg-999");
    expect(sm.getManifest().lastEntryId).toBe("entry-msg-999");
  });

  it("mirrors session lines and immediately flushes on terminate", async () => {
    const payload = createTestPayload();
    const sm = new RunStateMachine({
      payload,
      storageSink: sink,
      sessionDebounceMs: 50, // Short debounce for testing
    });

    await sm.transitionTo("running");

    sm.appendSessionChunk('{"type":"agent_start","id":"turn-1"}\n');
    sm.appendSessionChunk('{"type":"message_start","id":"msg-1"}\n');

    // Manually trigger flush
    await sm.flushSession();

    const sessionBuf = await sink.getObject("runs/run-20260906-state01/session.jsonl");
    const sessionContent = sessionBuf.toString("utf8");
    expect(sessionContent).toContain("agent_start");
    expect(sessionContent).toContain("message_start");

    // Add another line and finalize
    sm.appendSessionChunk('{"type":"turn_end","id":"turn-1"}\n');
    await sm.finalize("terminated", { reason: "User cancelled" });

    const finalSessionBuf = await sink.getObject("runs/run-20260906-state01/session.jsonl");
    expect(finalSessionBuf.toString("utf8")).toContain("turn_end");

    const finalManifestBuf = await sink.getObject("runs/run-20260906-state01/manifest.json");
    const finalManifest = JSON.parse(finalManifestBuf.toString("utf8"));
    expect(finalManifest.status).toBe("terminated");
  });

  it("mirrors session from tracked local session file", async () => {
    const payload = createTestPayload();
    const sm = new RunStateMachine({
      payload,
      storageSink: sink,
    });

    const localSessionFile = path.join(tempBaseDir, "local-session.jsonl");
    fs.writeFileSync(
      localSessionFile,
      '{"type":"turn_start","index":0}\n{"type":"message_end","text":"done"}\n',
      "utf8",
    );

    sm.trackSessionFile(localSessionFile);
    await sm.flushSession();

    const mirroredBuf = await sink.getObject("runs/run-20260906-state01/session.jsonl");
    expect(mirroredBuf.toString("utf8")).toBe(
      '{"type":"turn_start","index":0}\n{"type":"message_end","text":"done"}\n',
    );
  });

  it("retries failed storage operations", async () => {
    let callCount = 0;
    const flakySink = new FakeStorageSink();
    const originalPut = flakySink.putObject.bind(flakySink);

    flakySink.putObject = async (key, data, type) => {
      callCount++;
      if (callCount < 2) {
        throw new Error("Simulated S3 503 Service Unavailable");
      }
      return originalPut(key, data, type);
    };

    const payload = createTestPayload();
    const sm = new RunStateMachine({
      payload,
      storageSink: flakySink,
    });

    // Should succeed on second attempt
    await sm.transitionTo("running");
    expect(sm.getStatus()).toBe("running");
    expect(callCount).toBe(2);
  });
});
