/**
 * In-VM Runner Service Entrypoint and Orchestrator.
 * Orchestrates:
 *  - Lifecycle Hook Server (port 9000, 0.0.0.0)
 *  - Run State Machine and persistence (S3 / LocalStorageSink)
 *  - Secrets resolution (AWS Secrets Manager / FakeSecretsProvider)
 *  - Pi environment assembly (~/.pi/agent)
 *  - Workspace preparation (git clone, branch checkout, install scripts)
 *  - Pi Process Manager (headless pi in RPC mode with LF-only JSONL bridge)
 *  - Lifecycle Policy Manager (idle suspension, auto-checkpointing, termination)
 *  - Runner HTTP REST, SSE streaming, and WebSocket RPC API Server (port 8080)
 *  - Real-time metrics collector
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { type FinalizeRequest, ProtocolErrorCode, type RunnerStatus } from "../shared/protocol.js";
import { DEFAULT_API_HOST, DEFAULT_API_PORT, RunnerApiServer } from "./api.js";
import {
  DEFAULT_HOOK_HOST,
  DEFAULT_HOOK_PORT,
  LifecycleHookServer,
  type RunHookData,
  type ValidationResult,
  defaultSelfCheck,
} from "./hooks.js";
import {
  DEFAULT_IDLE_GRACE_SEC,
  DEFAULT_MAX_DURATION_SEC,
  DEFAULT_SUSPEND_AFTER_IDLE_SEC,
  DEFAULT_TERMINATE_AFTER_SUSPENDED_SEC,
  LifecyclePolicyManager,
} from "./lifecycle.js";
import { type Logger, StructuredLogger } from "./logger.js";
import { MetricsCollector } from "./metrics.js";
import { assembleInVmPiEnvironment } from "./pi-config.js";
import { PiProcessManager } from "./pi-process.js";
import { SecretsManagerProvider, type SecretsProvider } from "./secrets.js";
import { RunStateMachine } from "./state.js";
import { LocalStorageSink, S3StorageSink, type StorageSink } from "./storage.js";
import { type PrepareWorkspaceResult, prepareWorkspace } from "./workspace.js";

export interface RunnerServerOptions {
  hookPort?: number;
  hookHost?: string;
  apiPort?: number;
  apiHost?: string;
  secretsProvider?: SecretsProvider;
  storageSink?: StorageSink;
  logger?: Logger;
  workDir?: string;
  piAgentDir?: string;
  sessionDir?: string;
  piBinary?: string;
  gitAskPassPath?: string;
  extensions?: string[];
  customGitRunner?: (
    args: string[],
    cwd?: string,
    timeoutMs?: number,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  validateSelfCheck?: () => Promise<ValidationResult> | ValidationResult;
}

export class RunnerServer {
  private readonly options: RunnerServerOptions;
  private readonly logger: Logger;

  private hookServer: LifecycleHookServer | null = null;
  private apiServer: RunnerApiServer | null = null;
  private stateMachine: RunStateMachine | null = null;
  private metricsCollector: MetricsCollector | null = null;
  private lifecycleManager: LifecyclePolicyManager | null = null;
  private piProcess: PiProcessManager | null = null;
  private workspaceResult: PrepareWorkspaceResult | null = null;

  private secretsProvider: SecretsProvider;
  private storageSink: StorageSink;

  private isStarted = false;
  private isProvisioned = false;
  private provisioningPromise: Promise<void> | null = null;

  constructor(options: RunnerServerOptions = {}) {
    this.options = options;
    this.logger = options.logger ?? new StructuredLogger();

    // Configure storage sink fallback
    if (options.storageSink) {
      this.storageSink = options.storageSink;
    } else if (process.env.PI_CLOUD_BUCKET) {
      this.storageSink = new S3StorageSink({
        bucket: process.env.PI_CLOUD_BUCKET,
        region: process.env.AWS_REGION ?? "us-east-1",
      });
    } else {
      const localRunDir = path.join(process.cwd(), ".tmp", "runs");
      this.storageSink = new LocalStorageSink({ baseDir: localRunDir });
    }

    // Configure secrets provider fallback
    if (options.secretsProvider) {
      this.secretsProvider = options.secretsProvider;
    } else {
      this.secretsProvider = new SecretsManagerProvider({
        region: process.env.AWS_REGION ?? "us-east-1",
      });
    }
  }

  public getHookServer(): LifecycleHookServer | null {
    return this.hookServer;
  }

  public getApiServer(): RunnerApiServer | null {
    return this.apiServer;
  }

  public getStateMachine(): RunStateMachine | null {
    return this.stateMachine;
  }

  public getMetricsCollector(): MetricsCollector | null {
    return this.metricsCollector;
  }

  public getLifecycleManager(): LifecyclePolicyManager | null {
    return this.lifecycleManager;
  }

  public getPiProcess(): PiProcessManager | null {
    return this.piProcess;
  }

  public getWorkspaceResult(): PrepareWorkspaceResult | null {
    return this.workspaceResult;
  }

  public isReady(): boolean {
    return this.isProvisioned && (this.hookServer?.isReady() ?? false);
  }

  /**
   * Starts the LifecycleHookServer listening on port 9000.
   */
  public async start(): Promise<{ hookPort: number }> {
    if (this.isStarted) {
      return { hookPort: this.hookServer?.getPort() ?? DEFAULT_HOOK_PORT };
    }

    const hookPort =
      this.options.hookPort ??
      (process.env.HOOK_PORT ? Number.parseInt(process.env.HOOK_PORT, 10) : DEFAULT_HOOK_PORT);
    const hookHost = this.options.hookHost ?? DEFAULT_HOOK_HOST;

    this.hookServer = new LifecycleHookServer({
      port: hookPort,
      host: hookHost,
      logger: this.logger,
      validateSelfCheck: this.options.validateSelfCheck ?? defaultSelfCheck,
      onRun: (data: RunHookData) => this.handleRunHook(data),
      onResume: () => this.handleResumeHook(),
      onSuspend: () => this.handleSuspendHook(),
      onTerminate: () => this.handleTerminateHook(),
    });

    const boundHookPort = await this.hookServer.start();
    this.isStarted = true;
    this.logger.info(`RunnerServer hook listener bound on ${hookHost}:${boundHookPort}`);

    return { hookPort: boundHookPort };
  }

  /**
   * Handles hypervisor POST /run hook.
   * Asynchronously provisions workspace, starts pi, mounts API server.
   */
  private async handleRunHook(data: RunHookData): Promise<void> {
    if (data.error || !data.payload) {
      this.logger.error("Rejecting /run hook due to missing or invalid payload", data.error);
      return;
    }

    const payload = data.payload;

    this.logger.info(`Processing run hook for run '${payload.runId}' (microvm: ${data.microvmId})`);

    // Asynchronous provisioning task
    this.provisioningPromise = (async () => {
      try {
        // 1. Initialize RunStateMachine and save initial manifest
        this.stateMachine = new RunStateMachine({
          storageSink: this.storageSink,
          payload,
          microvmId: data.microvmId,
          logger: this.logger,
        });
        await this.stateMachine.persistManifest();

        // 2. Assemble in-VM pi environment and credentials
        const piAgentDir = this.options.piAgentDir ?? path.join(process.cwd(), ".pi-agent");
        const assembled = await assembleInVmPiEnvironment({
          payload,
          secretsProvider: this.secretsProvider,
          storageSink: this.storageSink,
          targetDir: piAgentDir,
          logger: this.logger,
        });

        // 3. Prepare workspace repository
        const workDir = this.options.workDir ?? path.join(process.cwd(), "work");
        this.workspaceResult = await prepareWorkspace({
          payload,
          repoConfig: undefined, // Will read .pi/config.json if present
          gitAskPassPath: this.options.gitAskPassPath,
          workingDirectory: workDir,
          env: assembled.env,
          logger: this.logger,
        });

        // 4. Initialize PiProcessManager
        const sessionDir = this.options.sessionDir ?? path.join(process.cwd(), ".pi-sessions");
        this.piProcess = new PiProcessManager({
          workingDirectory: this.workspaceResult.workingDirectory,
          sessionDir,
          env: assembled.env,
          piBinary: this.options.piBinary,
          provider: payload.model.provider,
          model: payload.model.id,
          thinking: payload.model.thinking,
          approve: payload.options?.trustProjectConfig ?? true,
          extensions: this.options.extensions,
          logger: this.logger,
        });

        // Start pi process
        await this.piProcess.start();

        // Track session file for storage sink mirroring
        if (this.piProcess.getSessionFile()) {
          this.stateMachine.trackSessionFile(this.piProcess.getSessionFile()!);
        }
        this.piProcess.on("session_file", (file: string) => {
          this.stateMachine?.trackSessionFile(file);
        });
        this.piProcess.on("raw_line", (line: string) => {
          this.stateMachine?.appendSessionChunk(`${line}\n`);
        });

        // 5. Initialize MetricsCollector
        this.metricsCollector = new MetricsCollector(this.stateMachine, this.piProcess, {
          payload,
          repoPath: this.workspaceResult.workingDirectory,
          logger: this.logger,
        });
        this.metricsCollector.startSampling();

        // 6. Initialize LifecyclePolicyManager
        this.lifecycleManager = new LifecyclePolicyManager(
          this.stateMachine,
          this.piProcess,
          {
            idleGraceSec: payload.options?.idleGraceSec ?? DEFAULT_IDLE_GRACE_SEC,
            suspendAfterIdleSec:
              payload.options?.suspendAfterIdleSec ?? DEFAULT_SUSPEND_AFTER_IDLE_SEC,
            terminateAfterSuspendedSec:
              payload.options?.terminateAfterSuspendedSec ?? DEFAULT_TERMINATE_AFTER_SUSPENDED_SEC,
            maxDurationSec: payload.options?.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC,
            autoPush: payload.options?.autoPush ?? true,
            repoPath: this.workspaceResult.workingDirectory,
            gitRunner: this.options.customGitRunner,
          },
          this.logger,
          payload,
        );

        // 7. Start RunnerApiServer on port 8080
        const apiPort =
          this.options.apiPort ??
          (process.env.APP_PORT ? Number.parseInt(process.env.APP_PORT, 10) : DEFAULT_API_PORT);
        const apiHost = this.options.apiHost ?? DEFAULT_API_HOST;

        this.apiServer = new RunnerApiServer({
          port: apiPort,
          host: apiHost,
          runStateMachine: this.stateMachine,
          piProcess: this.piProcess,
          metricsCollector: this.metricsCollector,
          logger: this.logger,
          getStatus: async (): Promise<RunnerStatus> => {
            const summary = this.lifecycleManager?.getStatusSummary();
            return {
              status: this.stateMachine?.getStatus() ?? "running",
              runId: payload.runId,
              uptimeSeconds: summary?.uptimeSeconds ?? 0,
              activeConnections: summary?.activeConnections ?? 0,
              lastActivityAt: summary?.lastActivityAt ?? new Date().toISOString(),
              pi: {
                running: this.piProcess?.getState() === "running",
                pid: this.piProcess?.getPid(),
                currentSessionId: this.piProcess?.getSessionId(),
                lastEventAt: summary?.pi?.lastEventAt,
              },
            };
          },
          getMetrics: async () => {
            return this.metricsCollector?.getFullMetrics() as unknown as Record<string, unknown>;
          },
          onFinalize: async (req: FinalizeRequest) => {
            const commitMsg = req.commitMessage ?? "Finalize request";
            this.logger.info(`Finalizing run '${payload.runId}': ${commitMsg}`);
            await this.lifecycleManager?.finalize("completed", commitMsg);
          },
          onShutdown: async () => {
            this.logger.info(`Shutting down runner for run '${payload.runId}'`);
            await this.stop();
          },
          onCheckpoint: async () => {
            await this.lifecycleManager?.createCheckpointCommit("Manual checkpoint request");
          },
        });

        await this.apiServer.listen(apiPort, apiHost);

        // 8. Transition state to running / ready
        await this.stateMachine.transitionTo(
          "running",
          "Workspace prepared, pi process started, API server ready",
        );

        // 9. Mark hook server initialized
        this.hookServer?.setReady(true);
        this.isProvisioned = true;

        this.logger.info(`Runner fully provisioned and ready for run '${payload.runId}'`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Provisioning failed for run '${payload.runId}': ${errMsg}`, err);

        if (this.stateMachine) {
          try {
            this.stateMachine.setError({
              code: ProtocolErrorCode.INTERNAL_ERROR,
              message: errMsg,
            });
            await this.stateMachine.transitionTo("failed", `Provisioning failed: ${errMsg}`);
          } catch (transErr) {
            this.logger.error("Failed to transition state machine to failed state", transErr);
          }
        }
      }
    })();
  }

  /**
   * Handles hypervisor POST /resume hook.
   */
  private async handleResumeHook(): Promise<void> {
    this.logger.info("Executing resume hook handler");
    if (this.lifecycleManager) {
      await this.lifecycleManager.handleResume();
    }
  }

  /**
   * Handles hypervisor POST /suspend hook.
   */
  private async handleSuspendHook(): Promise<void> {
    this.logger.info("Executing suspend hook handler");
    if (this.lifecycleManager) {
      await this.lifecycleManager.handleSuspend();
    }
  }

  /**
   * Handles hypervisor POST /terminate hook.
   */
  private async handleTerminateHook(): Promise<void> {
    this.logger.info("Executing terminate hook handler");
    if (this.lifecycleManager) {
      await this.lifecycleManager.handleTerminate();
    }
    await this.stop();
  }

  /**
   * Waits for provisioning to complete (if in progress).
   */
  public async waitForProvisioning(): Promise<void> {
    if (this.provisioningPromise) {
      await this.provisioningPromise;
    }
  }

  /**
   * Stops the runner services gracefully.
   */
  public async stop(): Promise<void> {
    this.logger.info("Stopping RunnerServer...");

    if (this.metricsCollector) {
      try {
        this.metricsCollector.stopSampling();
      } catch (err) {
        this.logger.warn("Error stopping MetricsCollector:", err);
      }
      this.metricsCollector = null;
    }

    if (this.apiServer) {
      try {
        await this.apiServer.close();
      } catch (err) {
        this.logger.warn("Error stopping API server:", err);
      }
      this.apiServer = null;
    }

    if (this.piProcess) {
      try {
        await this.piProcess.stop();
      } catch (err) {
        this.logger.warn("Error stopping PiProcessManager:", err);
      }
      this.piProcess = null;
    }

    if (this.hookServer) {
      try {
        await this.hookServer.stop();
      } catch (err) {
        this.logger.warn("Error stopping HookServer:", err);
      }
      this.hookServer = null;
    }

    this.isStarted = false;
    this.isProvisioned = false;
    this.logger.info("RunnerServer stopped successfully");
  }
}

/**
 * Creates and starts a default RunnerServer instance.
 */
export async function createRunnerServer(options: RunnerServerOptions = {}): Promise<RunnerServer> {
  const server = new RunnerServer(options);
  await server.start();
  return server;
}

// Auto-run if executed as main CLI entrypoint
if (
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    process.argv[1].endsWith("/runner/main.js") ||
    process.argv[1].endsWith("/runner/main.ts") ||
    process.argv[1].endsWith("/runner/index.js"))
) {
  const runner = new RunnerServer();
  runner.start().catch((err) => {
    console.error("Fatal runner startup error:", err);
    process.exit(1);
  });

  const handleSignal = async (sig: string) => {
    console.log(`Received ${sig}, shutting down runner...`);
    await runner.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
}
