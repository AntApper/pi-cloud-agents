/**
 * Runner Lifecycle Policy and Idle Management.
 * Computes agent idle time, tracks attached clients, provides controller advisory actions
 * (none, suspend, terminate), manages auto-checkpoint git commits on agent settlement,
 * handles suspend/resume/terminate hooks, and triggers 8-hour max duration warnings.
 */

import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { promisify } from "node:util";
import type { LaunchPayload, RunStatus } from "../shared/protocol.js";
import type { Logger } from "./logger.js";
import type { PiProcessManager } from "./pi-process.js";
import type { RunStateMachine } from "./state.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_IDLE_GRACE_SEC = 300; // 5 minutes
export const DEFAULT_SUSPEND_AFTER_IDLE_SEC = 600; // 10 minutes
export const DEFAULT_TERMINATE_AFTER_SUSPENDED_SEC = 1800; // 30 minutes
export const DEFAULT_MAX_DURATION_SEC = 28800; // 8 hours hard cap
export const DEFAULT_MAX_DURATION_WARNING_WINDOW_SEC = 900; // 15 minutes
export const DEFAULT_PUSH_TIMEOUT_MS = 5000; // 5 seconds push timeout

export type SuggestedLifecycleAction = "none" | "suspend" | "terminate";

export type AgentActivityState =
  | "starting"
  | "streaming"
  | "tool"
  | "idle"
  | "stopped"
  | "recovering"
  | "failed"
  | "completed"
  | "terminated";

export interface LifecyclePolicyOptions {
  idleGraceSec?: number;
  suspendAfterIdleSec?: number;
  terminateAfterSuspendedSec?: number;
  maxDurationSec?: number;
  autoPush?: boolean;
  pushTimeoutMs?: number;
  maxDurationWarningWindowSec?: number;
  repoPath?: string;
  clock?: () => number;
  gitRunner?: (
    args: string[],
    cwd?: string,
    timeoutMs?: number,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface LifecycleStatusSummary {
  status: string;
  runId: string;
  uptimeSeconds: number;
  activeConnections: number;
  lastActivityAt: string;
  agentState: AgentActivityState;
  attachedClientsCount: number;
  idleSince: string | null;
  policy: {
    idleGraceSec: number;
    suspendAfterIdleSec: number;
    terminateAfterSuspendedSec: number;
    maxDurationSec: number;
  };
  suggestedAction: SuggestedLifecycleAction;
  pi: {
    running: boolean;
    pid?: number;
    currentSessionId?: string;
    lastEventAt?: string;
  };
}

export class LifecyclePolicyManager extends EventEmitter {
  private readonly stateMachine: RunStateMachine;
  private readonly piProcess?: PiProcessManager;
  private readonly logger?: Logger;
  private readonly clock: () => number;
  private readonly repoPath?: string;

  private readonly idleGraceSec: number;
  private readonly suspendAfterIdleSec: number;
  private readonly terminateAfterSuspendedSec: number;
  private readonly maxDurationSec: number;
  private readonly maxDurationWarningWindowSec: number;
  private readonly autoPush: boolean;
  private readonly pushTimeoutMs: number;
  private readonly customGitRunner?: (
    args: string[],
    cwd?: string,
    timeoutMs?: number,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

  private startTime: number;
  private lastActivityTime: number;
  private lastEventTime?: number;
  private idleStartTime: number | null = null;
  private agentActivityState: AgentActivityState = "idle";
  private currentToolName?: string;
  private currentToolStartTime?: number;

  private attachedClients = new Map<string, number>(); // clientId -> lastSeenTime
  private checkpointIndex = 1;
  private maxDurationWarningEmitted = false;
  private commitLock: Promise<unknown> = Promise.resolve();

  constructor(
    stateMachine: RunStateMachine,
    piProcess?: PiProcessManager,
    options: LifecyclePolicyOptions = {},
    logger?: Logger,
    payload?: LaunchPayload,
  ) {
    super();
    this.stateMachine = stateMachine;
    this.piProcess = piProcess;
    this.logger = logger;
    this.clock = options.clock ?? (() => Date.now());
    this.repoPath = options.repoPath;
    this.customGitRunner = options.gitRunner;

    const payloadOpts = payload?.options;
    this.idleGraceSec = options.idleGraceSec ?? payloadOpts?.idleGraceSec ?? DEFAULT_IDLE_GRACE_SEC;
    this.suspendAfterIdleSec =
      options.suspendAfterIdleSec ??
      payloadOpts?.suspendAfterIdleSec ??
      DEFAULT_SUSPEND_AFTER_IDLE_SEC;
    this.terminateAfterSuspendedSec =
      options.terminateAfterSuspendedSec ??
      payloadOpts?.terminateAfterSuspendedSec ??
      DEFAULT_TERMINATE_AFTER_SUSPENDED_SEC;
    this.maxDurationSec =
      options.maxDurationSec ?? payloadOpts?.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC;
    this.maxDurationWarningWindowSec =
      options.maxDurationWarningWindowSec ?? DEFAULT_MAX_DURATION_WARNING_WINDOW_SEC;
    this.autoPush = options.autoPush ?? payloadOpts?.autoPush ?? false;
    this.pushTimeoutMs = options.pushTimeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS;

    const now = this.clock();
    this.startTime = now;
    this.lastActivityTime = now;

    this.bindProcessEvents();
  }

  private bindProcessEvents(): void {
    const pi = this.piProcess;
    if (!pi) return;

    pi.on("agent_start", () => {
      this.agentActivityState = "streaming";
      this.idleStartTime = null;
      this.recordActivity();
    });

    pi.on("turn_start", () => {
      this.agentActivityState = "streaming";
      this.idleStartTime = null;
      this.recordActivity();
    });

    pi.on("message_start", () => {
      this.agentActivityState = "streaming";
      this.idleStartTime = null;
      this.recordActivity();
    });

    pi.on("tool_execution_start", (event: Record<string, unknown>) => {
      this.agentActivityState = "tool";
      this.currentToolName = String(event.toolName || event.name || "unknown");
      this.currentToolStartTime = this.clock();
      this.idleStartTime = null;
      this.recordActivity();
    });

    pi.on("tool_execution_end", () => {
      this.agentActivityState = "streaming";
      this.currentToolName = undefined;
      this.currentToolStartTime = undefined;
      this.recordActivity();
    });

    pi.on("agent_settled", () => {
      this.agentActivityState = "idle";
      this.currentToolName = undefined;
      this.currentToolStartTime = undefined;
      this.recordActivity();

      // Check if we should mark idle start
      if (this.getAttachedClientsCount() === 0) {
        this.idleStartTime = this.clock();
      }

      // Auto-commit WIP changes to workBranch
      this.autoCommitWip(`checkpoint ${this.checkpointIndex}`).catch((err) => {
        this.logger?.warn?.(
          `Auto-commit on agent_settled failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });

    pi.on("event", () => {
      this.lastEventTime = this.clock();
      this.recordActivity();
    });

    pi.on("crashed", () => {
      this.agentActivityState = "recovering";
      this.recordActivity();
    });

    pi.on("failed", () => {
      this.agentActivityState = "failed";
      this.recordActivity();
    });

    pi.on("stopped", () => {
      this.agentActivityState = "stopped";
      this.recordActivity();
    });
  }

  public recordActivity(): void {
    this.lastActivityTime = this.clock();
    this.checkMaxDuration();
  }

  public recordClientPoll(clientId: string): void {
    this.attachedClients.set(clientId, this.clock());
    this.idleStartTime = null;
    this.recordActivity();
  }

  public registerClient(clientId: string): void {
    this.attachedClients.set(clientId, this.clock());
    this.idleStartTime = null;
    this.recordActivity();
  }

  public unregisterClient(clientId: string): void {
    this.attachedClients.delete(clientId);
    if (this.getAttachedClientsCount() === 0 && this.agentActivityState === "idle") {
      this.idleStartTime = this.clock();
    }
  }

  public getAttachedClientsCount(): number {
    const now = this.clock();
    const threshold = now - 60000; // 60s active threshold
    let count = 0;

    for (const [id, lastSeen] of this.attachedClients.entries()) {
      if (lastSeen >= threshold) {
        count++;
      } else {
        this.attachedClients.delete(id);
      }
    }

    return count;
  }

  public getAgentState(): AgentActivityState {
    return this.agentActivityState;
  }

  public getCurrentTool(): { name: string; elapsedMs: number } | undefined {
    if (this.agentActivityState === "tool" && this.currentToolName && this.currentToolStartTime) {
      return {
        name: this.currentToolName,
        elapsedMs: Math.max(0, this.clock() - this.currentToolStartTime),
      };
    }
    return undefined;
  }

  public getIdleSince(): string | null {
    if (
      this.idleStartTime !== null &&
      this.agentActivityState === "idle" &&
      this.getAttachedClientsCount() === 0
    ) {
      return new Date(this.idleStartTime).toISOString();
    }
    return null;
  }

  public getSuggestedAction(): SuggestedLifecycleAction {
    const now = this.clock();
    const currentStatus = this.stateMachine.getStatus();

    // 1. Terminal states suggest terminate
    if (
      currentStatus === "completed" ||
      currentStatus === "failed" ||
      currentStatus === "terminated"
    ) {
      return "terminate";
    }

    // 2. Hard max lifetime exceeded
    const totalRuntimeSec = (now - this.startTime) / 1000;
    if (totalRuntimeSec >= this.maxDurationSec) {
      return "terminate";
    }

    // 3. Suspended state
    if (currentStatus === "suspended") {
      return "none";
    }

    // 4. Idle calculation
    if (
      this.idleStartTime !== null &&
      this.agentActivityState === "idle" &&
      this.getAttachedClientsCount() === 0
    ) {
      const idleSec = (now - this.idleStartTime) / 1000;
      if (idleSec >= this.suspendAfterIdleSec) {
        return "suspend";
      }
      if (idleSec >= this.idleGraceSec) {
        return "suspend";
      }
    }

    return "none";
  }

  public checkMaxDuration(): boolean {
    const now = this.clock();
    const elapsedSec = (now - this.startTime) / 1000;
    const warningThresholdSec = this.maxDurationSec - this.maxDurationWarningWindowSec;

    if (elapsedSec >= warningThresholdSec && !this.maxDurationWarningEmitted) {
      this.maxDurationWarningEmitted = true;
      const remainingMin = Math.max(0, Math.round((this.maxDurationSec - elapsedSec) / 60));

      this.logger?.warn?.(
        `Run approaching maximum lifetime limit (${remainingMin} minutes remaining). Taking checkpoint.`,
      );

      this.emit("max_duration_warning", {
        elapsedSec,
        remainingSec: this.maxDurationSec - elapsedSec,
        maxDurationSec: this.maxDurationSec,
      });

      this.stateMachine
        .recordTimeline(
          "warning",
          `Approaching maximum duration limit (${remainingMin}m remaining). Automated checkpoint.`,
        )
        .catch(() => {});

      this.stateMachine.flushSession().catch(() => {});
      return true;
    }

    return false;
  }

  /**
   * Automatically commits dirty files to the workBranch and optionally pushes to remote origin.
   */
  public async autoCommitWip(message = `checkpoint ${this.checkpointIndex}`): Promise<boolean> {
    if (!this.repoPath || !fs.existsSync(this.repoPath)) {
      return false;
    }

    const run = async (): Promise<boolean> => {
      const runGit = async (
        args: string[],
        timeout = 10000,
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        if (this.customGitRunner) {
          return this.customGitRunner(args, this.repoPath, timeout);
        }
        try {
          const res = await execFileAsync("git", args, {
            cwd: this.repoPath,
            timeout,
          });
          return { stdout: res.stdout, stderr: res.stderr, exitCode: 0 };
        } catch (err: unknown) {
          const error = err as {
            stdout?: string;
            stderr?: string;
            code?: number;
            message?: string;
          };
          return {
            stdout: error.stdout || "",
            stderr: error.stderr || error.message || String(err),
            exitCode: typeof error.code === "number" ? error.code : 1,
          };
        }
      };

      // 1. Check status for uncommitted changes
      const statusRes = await runGit(["status", "--porcelain"]);
      if (!statusRes.stdout.trim()) {
        // Clean working tree
        return false;
      }

      // 2. Stage all modifications
      await runGit(["add", "-A"]);

      // 3. Create commit
      const commitMsg = `pi-cloud: ${message}`;
      const commitRes = await runGit(["commit", "-m", commitMsg]);
      if (commitRes.exitCode !== 0 && !commitRes.stdout.includes("nothing to commit")) {
        this.logger?.warn?.(`Git commit failed: ${commitRes.stderr}`);
        return false;
      }

      this.checkpointIndex++;

      // 4. Update manifest with commit hash
      const headRes = await runGit(["rev-parse", "HEAD"]);
      const lastCommit = headRes.stdout.trim();
      if (lastCommit) {
        await this.stateMachine.updateGit({ lastCommit });
      }

      // 5. Optional autoPush with bounded timeout
      if (this.autoPush) {
        const workBranch = this.stateMachine.getManifest().repo.workBranch;
        this.logger?.info?.(
          `Pushing work branch '${workBranch}' to origin (timeout: ${this.pushTimeoutMs}ms)`,
        );
        const pushRes = await runGit(["push", "origin", workBranch], this.pushTimeoutMs);
        if (pushRes.exitCode !== 0) {
          this.logger?.warn?.(`Git push failed (will retry next turn): ${pushRes.stderr}`);
        }
      }

      // 6. Flush session and manifest
      await this.stateMachine.flushSession();
      await this.stateMachine.persistManifest();

      this.emit("checkpoint_committed", {
        index: this.checkpointIndex - 1,
        lastCommit,
        message: commitMsg,
      });

      return true;
    };

    const next = this.commitLock.then(run, run);
    this.commitLock = next;
    return next;
  }

  /**
   * MicroVM Suspend Hook handler (/suspend).
   * Commits WIP changes and flushes session and manifest within deadline.
   */
  public async handleSuspend(): Promise<void> {
    this.logger?.info?.(
      "Handling /suspend lifecycle hook: committing WIP and flushing session/manifest",
    );
    try {
      await this.autoCommitWip("checkpoint before suspend");
    } catch (err) {
      this.logger?.warn?.(
        `WIP commit before suspend failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.stateMachine.transitionTo("suspended", "MicroVM suspended by hypervisor");
  }

  /**
   * MicroVM Terminate Hook handler (/terminate).
   * Commits WIP changes, pushes if configured, flushes final transcript, and sets manifest terminated.
   */
  public async handleTerminate(): Promise<void> {
    this.logger?.info?.("Handling /terminate lifecycle hook: performing final flush");
    try {
      await this.autoCommitWip("final checkpoint before terminate");
    } catch (err) {
      this.logger?.warn?.(
        `Final WIP commit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.stateMachine.transitionTo("terminated", "MicroVM terminated by hypervisor");
  }

  /**
   * Finalizes the run by committing WIP changes, pushing, and transitioning to a terminal state.
   */
  public async finalize(status: RunStatus = "completed", reason = "Run finalized"): Promise<void> {
    this.logger?.info?.(`Finalizing run with status '${status}': ${reason}`);
    try {
      await this.autoCommitWip(`final checkpoint: ${reason}`);
    } catch (err) {
      this.logger?.warn?.(
        `Final WIP commit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.stateMachine.transitionTo(status, reason);
  }

  /**
   * Creates an explicit checkpoint commit.
   */
  public async createCheckpointCommit(message?: string): Promise<boolean> {
    return this.autoCommitWip(message);
  }

  /**
   * MicroVM Resume Hook handler (/resume).
   * Resumes activity, re-establishes connections, and logs resumption.
   */
  public async handleResume(): Promise<void> {
    this.logger?.info?.("Handling /resume lifecycle hook: restoring runner state");
    const currentStatus = this.stateMachine.getStatus();
    if (currentStatus === "suspended") {
      await this.stateMachine.transitionTo("running", "MicroVM resumed from suspend");
    }
    this.recordActivity();
  }

  /**
   * Builds the comprehensive status summary for GET /v1/status.
   */
  public getStatusSummary(): LifecycleStatusSummary {
    const manifest = this.stateMachine.getManifest();
    const now = this.clock();
    const uptimeSeconds = Math.max(0, Math.floor((now - this.startTime) / 1000));
    const nowIso = new Date(now).toISOString();

    return {
      status: manifest.status,
      runId: manifest.runId,
      uptimeSeconds,
      activeConnections: this.getAttachedClientsCount(),
      lastActivityAt: new Date(this.lastActivityTime).toISOString(),
      agentState: this.agentActivityState,
      attachedClientsCount: this.getAttachedClientsCount(),
      idleSince: this.getIdleSince(),
      policy: {
        idleGraceSec: this.idleGraceSec,
        suspendAfterIdleSec: this.suspendAfterIdleSec,
        terminateAfterSuspendedSec: this.terminateAfterSuspendedSec,
        maxDurationSec: this.maxDurationSec,
      },
      suggestedAction: this.getSuggestedAction(),
      pi: {
        running: this.piProcess?.getState() === "running",
        pid: this.piProcess?.getPid(),
        currentSessionId: this.piProcess?.getSessionId(),
        lastEventAt: this.lastEventTime ? new Date(this.lastEventTime).toISOString() : nowIso,
      },
    };
  }
}
