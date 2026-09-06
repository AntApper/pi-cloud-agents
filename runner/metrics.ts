/**
 * Runner Metrics & Observability Collector.
 * Implements the metrics catalogue specified in 07-ux-and-observability.md §3:
 * - Lifecycle timeline milestones and measured durations
 * - Agent counters (turns, tool calls by tool name, errors, compactions)
 * - Model metrics (TTFT, turn durations, token usage, cost)
 * - Workspace metrics (git commit count, diff shortstat, last push)
 * - VM system resource ring buffer (5s samples over 6h window)
 * - Events/minute time series for dashboard sparkline (30m window)
 *
 * Real data rule: omits any field that cannot be measured. Never uses fabricated placeholder numbers.
 */

import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import type { LaunchPayload } from "../shared/protocol.js";
import type { Logger } from "./logger.js";
import type { PiProcessManager } from "./pi-process.js";
import type { RunStateMachine } from "./state.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_METRICS_SAMPLE_INTERVAL_MS = 5000; // 5s
export const MAX_RESOURCE_RING_BUFFER_SAMPLES = 4320; // 6 hours at 5s interval
export const MAX_EVENT_RATE_MINUTES = 30; // 30 minutes for sparkline

export interface VmResourceSample {
  at: string;
  load1m?: number;
  memUsedMb?: number;
  memTotalMb?: number;
  diskUsedMb?: number;
  diskTotalMb?: number;
  egressBytes?: number;
}

export interface LifecycleMilestone {
  name: string;
  at: string;
  durationMs?: number;
}

export interface ModelMetrics {
  provider: string;
  id: string;
  thinking?: boolean | { budgetTokens?: number };
  tokens?: {
    input: number;
    output: number;
    cacheRead?: number;
    total: number;
    estimatedCostUsd?: number;
  };
  ttft?: {
    lastMs?: number;
    avgMs?: number;
  };
  turnDuration?: {
    lastMs?: number;
    avgMs?: number;
  };
}

export interface WorkspaceMetrics {
  repo?: string;
  workBranch?: string;
  commits?: number;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  lastCheckpointAt?: string;
  lastPushAt?: string;
}

export interface AgentMetrics {
  state: string;
  turns: number;
  toolCallsTotal: number;
  toolCalls: Record<string, number>;
  prompts: number;
  errors: number;
  retries: number;
  compactions: number;
  currentTool?: {
    name: string;
    elapsedMs: number;
  };
  lastEventAgeSeconds?: number;
}

export interface FullMetricsPayload {
  runId: string;
  status: string;
  uptimeSeconds: number;
  lifecycle: {
    milestones: LifecycleMilestone[];
    launchToReadyMs?: number;
  };
  agent: AgentMetrics;
  model: ModelMetrics;
  workspace: WorkspaceMetrics;
  vm: {
    latest?: VmResourceSample;
    history: VmResourceSample[];
  };
  eventRateSeries: number[]; // Events per minute for last 30 min
}

export interface SummaryMetricsPayload {
  runId: string;
  status: string;
  uptimeSeconds: number;
  turns: number;
  toolCalls: Record<string, number>;
  currentTool?: { name: string; elapsedMs: number };
  lastEventAgeSeconds?: number;
  ttftAvgMs?: number;
  turnDurationAvgMs?: number;
  tokens?: {
    input: number;
    output: number;
    total: number;
    estimatedCostUsd?: number;
  };
  vmLatest?: VmResourceSample;
  eventsPerMinute: number;
}

export interface MetricsCollectorOptions {
  sampleIntervalMs?: number;
  repoPath?: string;
  workPath?: string;
  clock?: () => number;
  logger?: Logger;
  payload?: LaunchPayload;
}

export class MetricsCollector extends EventEmitter {
  private readonly stateMachine?: RunStateMachine;
  private readonly piProcess?: PiProcessManager;
  private readonly logger?: Logger;
  private readonly clock: () => number;
  private readonly repoPath?: string;
  private readonly workPath: string;
  private readonly sampleIntervalMs: number;

  private startTime: number;
  private readyTime?: number;
  private lastEventTime?: number;

  private milestones = new Map<string, LifecycleMilestone>();
  private toolCounters: Record<string, number> = {};
  private toolCallsTotal = 0;
  private turnsCount = 0;
  private promptsCount = 0;
  private errorsCount = 0;
  private retriesCount = 0;
  private compactionsCount = 0;

  private currentTurnStartTime?: number;
  private currentTurnFirstTokenTime?: number;
  private currentToolName?: string;
  private currentToolStartTime?: number;

  private ttftSamples: number[] = [];
  private turnDurationSamples: number[] = [];

  private tokenStats?: {
    input: number;
    output: number;
    cacheRead?: number;
    total: number;
    estimatedCostUsd?: number;
  };

  private workspaceStats: WorkspaceMetrics = {};
  private resourceRingBuffer: VmResourceSample[] = [];
  private eventBuckets = new Map<number, number>(); // minuteEpoch -> count

  private sampleTimer: NodeJS.Timeout | null = null;
  private modelProvider = "anthropic";
  private modelId = "claude-sonnet-4-6";
  private thinkingConfig?: boolean | { budgetTokens?: number };

  constructor(
    stateMachine?: RunStateMachine,
    piProcess?: PiProcessManager,
    options: MetricsCollectorOptions = {},
  ) {
    super();
    this.stateMachine = stateMachine;
    this.piProcess = piProcess;
    this.logger = options.logger;
    this.clock = options.clock ?? (() => Date.now());
    this.repoPath = options.repoPath;
    this.workPath = options.workPath ?? (fs.existsSync("/work") ? "/work" : process.cwd());
    this.sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_METRICS_SAMPLE_INTERVAL_MS;

    const payload = options.payload ?? (stateMachine?.getManifest() as unknown as LaunchPayload);
    if (payload?.model) {
      this.modelProvider = payload.model.provider;
      this.modelId = payload.model.id;
    }

    this.startTime = this.clock();
    this.recordMilestone("launch", this.startTime);

    this.bindEvents();
  }

  private bindEvents(): void {
    const pi = this.piProcess;
    if (!pi) return;

    pi.on("agent_start", () => {
      this.promptsCount++;
      this.recordEventInternal();
    });

    pi.on("turn_start", () => {
      this.currentTurnStartTime = this.clock();
      this.currentTurnFirstTokenTime = undefined;
      this.recordEventInternal();
    });

    pi.on("message_start", () => {
      this.recordEventInternal();
    });

    pi.on("message_update", () => {
      if (this.currentTurnStartTime && !this.currentTurnFirstTokenTime) {
        this.currentTurnFirstTokenTime = this.clock();
        const ttftMs = Math.max(0, this.currentTurnFirstTokenTime - this.currentTurnStartTime);
        this.ttftSamples.push(ttftMs);
      }
      this.recordEventInternal();
    });

    pi.on("tool_execution_start", (event: Record<string, unknown>) => {
      const toolName = String(event.toolName || event.name || "unknown");
      this.currentToolName = toolName;
      this.currentToolStartTime = this.clock();
      this.toolCounters[toolName] = (this.toolCounters[toolName] || 0) + 1;
      this.toolCallsTotal++;
      this.recordEventInternal();
    });

    pi.on("tool_execution_end", () => {
      this.currentToolName = undefined;
      this.currentToolStartTime = undefined;
      this.recordEventInternal();
    });

    pi.on("turn_end", () => {
      this.turnsCount++;
      if (this.currentTurnStartTime) {
        const turnDurationMs = Math.max(0, this.clock() - this.currentTurnStartTime);
        this.turnDurationSamples.push(turnDurationMs);
        this.currentTurnStartTime = undefined;
      }
      this.recordEventInternal();
    });

    pi.on("agent_settled", () => {
      this.currentToolName = undefined;
      this.currentToolStartTime = undefined;
      this.recordEventInternal();
      this.refreshWorkspaceDiff().catch(() => {});
    });

    pi.on("error", () => {
      this.errorsCount++;
      this.recordEventInternal();
    });

    pi.on("retry", () => {
      this.retriesCount++;
      this.recordEventInternal();
    });

    pi.on("compaction", () => {
      this.compactionsCount++;
      this.recordEventInternal();
    });

    pi.on("event", () => {
      this.recordEventInternal();
    });
  }

  private recordEventInternal(): void {
    const now = this.clock();
    this.lastEventTime = now;

    // Record into minute bucket for sparkline
    const minuteKey = Math.floor(now / 60000);
    this.eventBuckets.set(minuteKey, (this.eventBuckets.get(minuteKey) || 0) + 1);

    // Prune buckets older than 30 min
    const oldestKey = minuteKey - MAX_EVENT_RATE_MINUTES;
    for (const k of this.eventBuckets.keys()) {
      if (k < oldestKey) {
        this.eventBuckets.delete(k);
      }
    }
  }

  public recordMilestone(name: string, timestamp?: number, durationMs?: number): void {
    const at = new Date(timestamp ?? this.clock()).toISOString();
    this.milestones.set(name, { name, at, durationMs });

    if (name === "ready") {
      this.readyTime = timestamp ?? this.clock();
    }
  }

  public setTokenUsage(usage: {
    input: number;
    output: number;
    cacheRead?: number;
    total: number;
    estimatedCostUsd?: number;
  }): void {
    this.tokenStats = usage;
  }

  public async refreshWorkspaceDiff(): Promise<void> {
    if (!this.repoPath || !fs.existsSync(this.repoPath)) return;

    try {
      // 1. Commit count
      const { stdout: revCount } = await execFileAsync("git", ["rev-list", "--count", "HEAD"], {
        cwd: this.repoPath,
      });
      const commits = Number.parseInt(revCount.trim(), 10);
      if (!Number.isNaN(commits)) {
        this.workspaceStats.commits = commits;
      }

      // 2. Diff shortstat vs main/base
      const { stdout: shortstat } = await execFileAsync(
        "git",
        ["diff", "--shortstat", "main...HEAD"],
        {
          cwd: this.repoPath,
        },
      ).catch(() => ({ stdout: "" }));

      if (shortstat.trim()) {
        const filesMatch = shortstat.match(/(\d+)\s+file/);
        const insMatch = shortstat.match(/(\d+)\s+insertion/);
        const delMatch = shortstat.match(/(\d+)\s+deletion/);

        if (filesMatch?.[1]) this.workspaceStats.filesChanged = Number.parseInt(filesMatch[1], 10);
        if (insMatch?.[1]) this.workspaceStats.insertions = Number.parseInt(insMatch[1], 10);
        if (delMatch?.[1]) this.workspaceStats.deletions = Number.parseInt(delMatch[1], 10);
      }
    } catch {
      // Real data rule: omit on error
    }
  }

  /**
   * Samples VM system load, memory, disk, and egress bytes.
   * Only measures real available properties; omits unmeasurable fields.
   */
  public async sampleVmResources(): Promise<VmResourceSample | undefined> {
    const now = this.clock();
    const sample: VmResourceSample = {
      at: new Date(now).toISOString(),
    };

    // 1. System load
    try {
      const load = os.loadavg();
      if (
        Array.isArray(load) &&
        load.length > 0 &&
        typeof load[0] === "number" &&
        !Number.isNaN(load[0])
      ) {
        sample.load1m = Math.round(load[0] * 100) / 100;
      }
    } catch {
      // Omit if unmeasurable
    }

    // 2. Memory
    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      if (totalMem > 0) {
        sample.memTotalMb = Math.round(totalMem / (1024 * 1024));
        sample.memUsedMb = Math.round((totalMem - freeMem) / (1024 * 1024));
      }
    } catch {
      // Omit
    }

    // 3. Disk space on /work
    try {
      if (typeof fs.promises.statfs === "function") {
        const stats = await fs.promises.statfs(this.workPath);
        const totalBytes = stats.blocks * stats.bsize;
        const freeBytes = stats.bavail * stats.bsize;
        sample.diskTotalMb = Math.round(totalBytes / (1024 * 1024));
        sample.diskUsedMb = Math.round((totalBytes - freeBytes) / (1024 * 1024));
      }
    } catch {
      // Omit
    }

    // 4. Linux egress bytes from /proc/net/dev if present
    try {
      if (fs.existsSync("/proc/net/dev")) {
        const content = fs.readFileSync("/proc/net/dev", "utf8");
        const lines = content.split("\n");
        let totalTxBytes = 0;
        for (const line of lines) {
          if (line.includes(":") && !line.includes("lo:")) {
            const parts = line.split(":")[1]?.trim().split(/\s+/) || [];
            const txBytes = Number.parseInt(parts[8] || "0", 10);
            if (!Number.isNaN(txBytes)) {
              totalTxBytes += txBytes;
            }
          }
        }
        if (totalTxBytes > 0) {
          sample.egressBytes = totalTxBytes;
        }
      }
    } catch {
      // Omit
    }

    this.resourceRingBuffer.push(sample);
    if (this.resourceRingBuffer.length > MAX_RESOURCE_RING_BUFFER_SAMPLES) {
      this.resourceRingBuffer.shift();
    }

    return sample;
  }

  public startSampling(intervalMs = this.sampleIntervalMs): void {
    if (this.sampleTimer) return;

    this.sampleTimer = setInterval(() => {
      this.sampleVmResources().catch((err) => {
        this.logger?.warn?.(`VM sample error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, intervalMs);
  }

  public stopSampling(): void {
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
  }

  public getEventRateSeries(): number[] {
    const now = this.clock();
    const currentMinuteKey = Math.floor(now / 60000);
    const series: number[] = [];

    for (let i = MAX_EVENT_RATE_MINUTES - 1; i >= 0; i--) {
      const minute = currentMinuteKey - i;
      series.push(this.eventBuckets.get(minute) || 0);
    }

    return series;
  }

  public getFullMetrics(): FullMetricsPayload {
    const now = this.clock();
    const uptimeSeconds = Math.max(0, Math.floor((now - this.startTime) / 1000));
    const manifest = this.stateMachine?.getManifest();

    const lastTtft =
      this.ttftSamples.length > 0 ? this.ttftSamples[this.ttftSamples.length - 1] : undefined;
    const avgTtft =
      this.ttftSamples.length > 0
        ? Math.round(this.ttftSamples.reduce((a, b) => a + b, 0) / this.ttftSamples.length)
        : undefined;

    const lastTurnDuration =
      this.turnDurationSamples.length > 0
        ? this.turnDurationSamples[this.turnDurationSamples.length - 1]
        : undefined;
    const avgTurnDuration =
      this.turnDurationSamples.length > 0
        ? Math.round(
            this.turnDurationSamples.reduce((a, b) => a + b, 0) / this.turnDurationSamples.length,
          )
        : undefined;

    const lastEventAgeSeconds =
      this.lastEventTime !== undefined
        ? Math.max(0, Math.floor((now - this.lastEventTime) / 1000))
        : undefined;

    const currentTool =
      this.currentToolName && this.currentToolStartTime
        ? {
            name: this.currentToolName,
            elapsedMs: Math.max(0, now - this.currentToolStartTime),
          }
        : undefined;

    const launchToReadyMs =
      this.readyTime !== undefined ? Math.max(0, this.readyTime - this.startTime) : undefined;

    const latestVmSample =
      this.resourceRingBuffer.length > 0
        ? this.resourceRingBuffer[this.resourceRingBuffer.length - 1]
        : undefined;

    return {
      runId: manifest?.runId ?? "run-local",
      status: manifest?.status ?? "running",
      uptimeSeconds,
      lifecycle: {
        milestones: Array.from(this.milestones.values()),
        launchToReadyMs,
      },
      agent: {
        state: manifest?.status ?? "running",
        turns: this.turnsCount,
        toolCallsTotal: this.toolCallsTotal,
        toolCalls: { ...this.toolCounters },
        prompts: this.promptsCount,
        errors: this.errorsCount,
        retries: this.retriesCount,
        compactions: this.compactionsCount,
        currentTool,
        lastEventAgeSeconds,
      },
      model: {
        provider: this.modelProvider,
        id: this.modelId,
        thinking: this.thinkingConfig,
        tokens: this.tokenStats,
        ttft:
          lastTtft !== undefined || avgTtft !== undefined
            ? {
                lastMs: lastTtft,
                avgMs: avgTtft,
              }
            : undefined,
        turnDuration:
          lastTurnDuration !== undefined || avgTurnDuration !== undefined
            ? {
                lastMs: lastTurnDuration,
                avgMs: avgTurnDuration,
              }
            : undefined,
      },
      workspace: {
        repo: manifest?.repo.url,
        workBranch: manifest?.repo.workBranch,
        commits: this.workspaceStats.commits,
        filesChanged: this.workspaceStats.filesChanged,
        insertions: this.workspaceStats.insertions,
        deletions: this.workspaceStats.deletions,
        lastCheckpointAt: this.workspaceStats.lastCheckpointAt,
        lastPushAt: this.workspaceStats.lastPushAt,
      },
      vm: {
        latest: latestVmSample,
        history: [...this.resourceRingBuffer],
      },
      eventRateSeries: this.getEventRateSeries(),
    };
  }

  public getSummaryMetrics(): SummaryMetricsPayload {
    const full = this.getFullMetrics();
    const currentMinuteEvents =
      full.eventRateSeries.length > 0
        ? full.eventRateSeries[full.eventRateSeries.length - 1] || 0
        : 0;

    return {
      runId: full.runId,
      status: full.status,
      uptimeSeconds: full.uptimeSeconds,
      turns: full.agent.turns,
      toolCalls: full.agent.toolCalls,
      currentTool: full.agent.currentTool,
      lastEventAgeSeconds: full.agent.lastEventAgeSeconds,
      ttftAvgMs: full.model.ttft?.avgMs,
      turnDurationAvgMs: full.model.turnDuration?.avgMs,
      tokens: full.model.tokens
        ? {
            input: full.model.tokens.input,
            output: full.model.tokens.output,
            total: full.model.tokens.total,
            estimatedCostUsd: full.model.tokens.estimatedCostUsd,
          }
        : undefined,
      vmLatest: full.vm.latest,
      eventsPerMinute: currentMinuteEvents,
    };
  }
}
