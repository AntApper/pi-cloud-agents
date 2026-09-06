import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../runner/logger.js";
import { PiProcessCrashError, PiProcessManager } from "../../runner/pi-process.js";
import { ProtocolErrorCode } from "../../shared/protocol.js";

describe("T2.4 Pi Process Manager (RPC Bridge)", () => {
  let tempBaseDir: string;
  let fakePiScript: string;
  let sessionDir: string;
  let repoDir: string;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cloud-piproc-test-"));
    sessionDir = path.join(tempBaseDir, "sessions");
    repoDir = path.join(tempBaseDir, "repo");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });

    fakePiScript = path.resolve(__dirname, "../fakes/fake-pi.ts");
  });

  afterEach(() => {
    if (fs.existsSync(tempBaseDir)) {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    }
  });

  it("spawns fake pi process and handles prompt -> event stream -> agent_settled", async () => {
    const logger = createLogger({ level: "debug" });
    const manager = new PiProcessManager({
      workingDirectory: repoDir,
      sessionDir,
      piBinary: fakePiScript,
      logger,
    });

    const receivedEvents: string[] = [];
    manager.on("event", (evt: { type: string }) => {
      receivedEvents.push(evt.type);
    });

    await manager.start();
    expect(manager.getState()).toBe("running");

    const promptPromise = new Promise<void>((resolve) => {
      manager.once("agent_settled", () => {
        resolve();
      });
    });

    await manager.prompt("Hello world");
    await promptPromise;

    expect(receivedEvents).toContain("agent_start");
    expect(receivedEvents).toContain("turn_start");
    expect(receivedEvents).toContain("message_start");
    expect(receivedEvents).toContain("message_update");
    expect(receivedEvents).toContain("message_end");
    expect(receivedEvents).toContain("turn_end");
    expect(receivedEvents).toContain("agent_settled");

    await manager.stop();
    expect(manager.getState()).toBe("stopped");
  });

  it("safely handles Unicode line separators U+2028 and U+2029 without splitting records", async () => {
    const manager = new PiProcessManager({
      workingDirectory: repoDir,
      sessionDir,
      piBinary: fakePiScript,
    });

    let messageContent = "";
    manager.on("message_end", (msg: { content?: Array<{ text: string }> }) => {
      messageContent = msg.content?.[0]?.text ?? "";
    });

    await manager.start();

    const promptPromise = new Promise<void>((resolve) => {
      manager.once("agent_settled", () => {
        resolve();
      });
    });

    await manager.prompt("__U2028__");
    await promptPromise;

    // Verify content preserves both U+2028 and U+2029 intact
    expect(messageContent).toBe("Line1\u2028Line2\u2029Line3");
    expect(messageContent).toContain("\u2028");
    expect(messageContent).toContain("\u2029");

    await manager.stop();
  });

  it("queries health state via queryState RPC probe", async () => {
    const manager = new PiProcessManager({
      workingDirectory: repoDir,
      sessionDir,
      piBinary: fakePiScript,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    await manager.start();
    const state = (await manager.queryState()) as {
      state: string;
      sessionId: string;
      model: { provider: string; id: string };
    };

    expect(state.state).toBe("idle");
    expect(state.sessionId).toBeDefined();
    expect(state.model.provider).toBe("anthropic");
    expect(state.model.id).toBe("claude-sonnet-4-6");

    await manager.stop();
  });

  it("recovers from process crash on first failure and continues session", async () => {
    const logger = createLogger({ level: "debug" });
    const manager = new PiProcessManager({
      workingDirectory: repoDir,
      sessionDir,
      piBinary: fakePiScript,
      maxRestarts: 1,
      logger,
    });

    let crashEventObserved = false;
    let recoveredEventObserved = false;

    manager.on("crashed", () => {
      crashEventObserved = true;
    });

    manager.on("recovered", () => {
      recoveredEventObserved = true;
    });

    await manager.start();
    const initialPid = manager.getPid();

    // Trigger simulated crash
    try {
      await manager.prompt("__CRASH__");
    } catch {
      // Expected rejection on process exit
    }

    // Wait for recovery to complete
    await new Promise<void>((resolve) => {
      manager.once("recovered", () => {
        resolve();
      });
    });

    expect(crashEventObserved).toBe(true);
    expect(recoveredEventObserved).toBe(true);
    expect(manager.getState()).toBe("running");
    expect(manager.getPid()).not.toBe(initialPid);

    // Verify process is functional after restart
    const state = (await manager.queryState()) as { state: string };
    expect(state.state).toBe("idle");

    await manager.stop();
  });

  it("marks state failed with PiProcessCrashError when crashes exceed maxRestarts", async () => {
    const manager = new PiProcessManager({
      workingDirectory: repoDir,
      sessionDir,
      piBinary: fakePiScript,
      maxRestarts: 1,
    });

    await manager.start();

    // 1. First crash -> recovers
    try {
      await manager.prompt("__CRASH__");
    } catch {
      // Ignore
    }

    await new Promise<void>((resolve) => {
      manager.once("recovered", () => {
        resolve();
      });
    });

    expect(manager.getState()).toBe("running");

    // 2. Second crash -> fails permanently
    const failurePromise = new Promise<PiProcessCrashError>((resolve) => {
      manager.once("failed", (err: PiProcessCrashError) => {
        resolve(err);
      });
    });

    try {
      await manager.prompt("__CRASH__");
    } catch {
      // Ignore
    }

    const fatalError = await failurePromise;
    expect(manager.getState()).toBe("failed");
    expect(fatalError).toBeInstanceOf(PiProcessCrashError);
    expect(fatalError.code).toBe(ProtocolErrorCode.PI_PROCESS_CRASH);
    expect(fatalError.crashCount).toBe(2);
  });

  it("performs graceful shutdown via stop()", async () => {
    const manager = new PiProcessManager({
      workingDirectory: repoDir,
      sessionDir,
      piBinary: fakePiScript,
    });

    await manager.start();
    expect(manager.getState()).toBe("running");

    await manager.stop(2000);
    expect(manager.getState()).toBe("stopped");
    expect(manager.getPid()).toBeUndefined();
  });
});
