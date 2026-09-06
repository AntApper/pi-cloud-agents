import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LifecyclePolicyManager } from "../../runner/lifecycle.js";
import { PiProcessManager } from "../../runner/pi-process.js";
import { RunStateMachine } from "../../runner/state.js";
import { LocalStorageSink } from "../../runner/storage.js";
import type { LaunchPayload } from "../../shared/protocol.js";

const execFileAsync = promisify(execFile);

const samplePayload: LaunchPayload = {
  v: 1,
  runId: "run-20260906-life01",
  owner: "user-ant",
  stack: {
    name: "pi-cloud-agents-core",
    region: "us-east-1",
    bucket: "test-bucket",
  },
  repo: {
    url: "https://github.com/example/repo.git",
    workBranch: "pi-cloud/run-life01",
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

describe("T2.7 Lifecycle Policy & Idle Management", () => {
  let tmpDir: string;
  let sinkDir: string;
  let sessionDir: string;
  let repoDir: string;
  let stateMachine: RunStateMachine;
  let simulatedTime: number;

  const fakeClock = () => simulatedTime;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cloud-life-test-"));
    sinkDir = path.join(tmpDir, "storage");
    sessionDir = path.join(tmpDir, "sessions");
    repoDir = path.join(tmpDir, "repo");

    fs.mkdirSync(sinkDir, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });

    // Initialize real git repo for auto-commit validation
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "Test Runner"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Initial Commit\n");
    await execFileAsync("git", ["add", "."], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "initial commit"], { cwd: repoDir });
    await execFileAsync("git", ["checkout", "-b", "pi-cloud/run-life01"], { cwd: repoDir });

    simulatedTime = 1788733200000; // Fixed starting epoch

    const storageSink = new LocalStorageSink({ baseDir: sinkDir });
    stateMachine = new RunStateMachine({
      payload: samplePayload,
      storageSink,
    });
  });

  afterEach(async () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("computes idle duration and transitions suggestedAction to suspend after idleGraceSec", async () => {
    const lifecycle = new LifecyclePolicyManager(stateMachine, undefined, {
      idleGraceSec: 300,
      suspendAfterIdleSec: 600,
      clock: fakeClock,
    });

    // Initial state: not idle yet
    expect(lifecycle.getIdleSince()).toBeNull();
    expect(lifecycle.getSuggestedAction()).toBe("none");

    // Client attaches -> activity recorded
    lifecycle.registerClient("client-1");
    expect(lifecycle.getAttachedClientsCount()).toBe(1);
    expect(lifecycle.getSuggestedAction()).toBe("none");

    // Client unregisters -> idle begins
    lifecycle.unregisterClient("client-1");
    expect(lifecycle.getIdleSince()).toBe(new Date(simulatedTime).toISOString());
    expect(lifecycle.getSuggestedAction()).toBe("none");

    // Advance clock 200s (below idleGraceSec 300s)
    simulatedTime += 200 * 1000;
    expect(lifecycle.getSuggestedAction()).toBe("none");

    // Advance clock past idleGraceSec (305s total idle)
    simulatedTime += 105 * 1000;
    expect(lifecycle.getSuggestedAction()).toBe("suspend");

    // Client polls -> idle resets
    lifecycle.recordClientPoll("client-2");
    expect(lifecycle.getIdleSince()).toBeNull();
    expect(lifecycle.getSuggestedAction()).toBe("none");
  });

  it("suggests terminate when run is in completed or terminated state or exceeds max duration", async () => {
    const lifecycle = new LifecyclePolicyManager(stateMachine, undefined, {
      maxDurationSec: 1000,
      clock: fakeClock,
    });

    expect(lifecycle.getSuggestedAction()).toBe("none");

    // StateMachine transitions to completed
    await stateMachine.transitionTo("running");
    await stateMachine.transitionTo("completed");

    expect(lifecycle.getSuggestedAction()).toBe("terminate");
  });

  it("automatically commits WIP git changes on agent_settled", async () => {
    const fakePiScript = path.resolve(__dirname, "../fakes/fake-pi.ts");
    const piProcess = new PiProcessManager({
      workingDirectory: repoDir,
      sessionDir,
      piBinary: fakePiScript,
    });
    await piProcess.start();

    const lifecycle = new LifecyclePolicyManager(stateMachine, piProcess, {
      repoPath: repoDir,
      clock: fakeClock,
    });

    // Make an uncommitted edit in the repository
    fs.writeFileSync(path.join(repoDir, "feature.txt"), "New feature code\n");

    const commitPromise = new Promise<void>((resolve) => {
      lifecycle.once("checkpoint_committed", () => resolve());
    });

    // Emit agent_settled to trigger auto-commit
    piProcess.emit("agent_settled");
    await commitPromise;

    // Verify commit was created
    const { stdout: logOut } = await execFileAsync("git", ["log", "-1", "--oneline"], {
      cwd: repoDir,
    });
    expect(logOut).toContain("pi-cloud: checkpoint 1");

    // Verify manifest git.lastCommit was updated
    const manifest = stateMachine.getManifest();
    expect(manifest.git?.lastCommit).toBeDefined();
    expect(lifecycle.getAgentState()).toBe("idle");

    await piProcess.stop();
  });

  it("handles suspend, resume, and terminate hooks cleanly", async () => {
    const lifecycle = new LifecyclePolicyManager(stateMachine, undefined, {
      repoPath: repoDir,
      clock: fakeClock,
    });

    // 1. Initial state -> running
    await stateMachine.transitionTo("running");

    // 2. Suspend hook
    await lifecycle.handleSuspend();
    expect(stateMachine.getStatus()).toBe("suspended");

    // 3. Resume hook
    await lifecycle.handleResume();
    expect(stateMachine.getStatus()).toBe("running");

    // 4. Terminate hook
    await lifecycle.handleTerminate();
    expect(stateMachine.getStatus()).toBe("terminated");
  });

  it("emits warning event and timeline entry when approaching max duration", async () => {
    const lifecycle = new LifecyclePolicyManager(stateMachine, undefined, {
      maxDurationSec: 3600, // 1 hour
      maxDurationWarningWindowSec: 900, // 15 min warning
      clock: fakeClock,
    });

    let warningEmitted = false;
    lifecycle.on("max_duration_warning", (data) => {
      warningEmitted = true;
      expect(data.maxDurationSec).toBe(3600);
    });

    // Advance clock to T-14 min (2760s elapsed out of 3600s)
    simulatedTime += 2760 * 1000;
    const triggered = lifecycle.checkMaxDuration();

    expect(triggered).toBe(true);
    expect(warningEmitted).toBe(true);

    const manifest = stateMachine.getManifest();
    expect(manifest.timeline.some((t) => t.status === "warning")).toBe(true);
  });

  it("generates comprehensive status summary matching LifecycleStatusSummary shape", async () => {
    const lifecycle = new LifecyclePolicyManager(stateMachine, undefined, {
      idleGraceSec: 300,
      maxDurationSec: 28800,
      clock: fakeClock,
    });

    const summary = lifecycle.getStatusSummary();
    expect(summary.runId).toBe("run-20260906-life01");
    expect(summary.agentState).toBe("idle");
    expect(summary.policy.idleGraceSec).toBe(300);
    expect(summary.policy.maxDurationSec).toBe(28800);
    expect(summary.suggestedAction).toBe("none");
  });
});
