/**
 * Cloud Agent Mirror Session Core (T4.7a).
 * Manages local pi mirror session binding, historical replay from /v1/entries,
 * live SSE event stream subscription, delta widgets, status badge updates,
 * local LLM safety guard, and session unbinding.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AwsClientFactory } from "../../core/aws/clients.js";
import { RunClient, type SseSubscription } from "../../core/client/run-client.js";
import { loadLocalConfig } from "../../core/config.js";
import { extractShortRunId } from "../../core/list.js";
import { fetchRunStatusDetails } from "../../core/status.js";
import type { SseEnvelope } from "../../shared/protocol.js";
import type { PiUiContext } from "../prompter-pi.js";
import { badge } from "./kit.js";

export interface CloudRunSessionMetadata {
  runId: string;
  shortRunId: string;
  cursor?: string;
  owner: string;
  status: string;
  createdAt?: string;
  endpoint?: string;
  microvmId?: string;
  repo?: string;
  model?: string;
}

export interface CloudMessageEntry {
  id: string;
  runId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  details?: {
    diff?: string;
    command?: string;
    exitCode?: number;
    durationMs?: number;
    [key: string]: unknown;
  };
  isError?: boolean;
  thinking?: string;
  timestamp: string;
  turnIndex?: number;
}

export interface LiveDeltaWidgetState {
  role?: string;
  text?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolCommand?: string;
  elapsedMs?: number;
  timestamp: string;
}

export interface MirrorAttachOptions {
  runId: string;
  ctx: PiUiContext;
  pi?: ExtensionAPI | null;
  cursor?: string;
  endpoint?: string;
  microvmId?: string;
  owner?: string;
  region?: string;
  profile?: string;
  clientFactory?: AwsClientFactory;
  fetchFn?: typeof fetch;
}

export class MirrorSession {
  readonly runId: string;
  readonly shortRunId: string;
  metadata: CloudRunSessionMetadata;
  readonly seenEntryIds = new Set<string>();
  cursor?: string;

  private readonly runClient: RunClient;
  private sseSubscription: SseSubscription | null = null;
  private isAttached = false;
  private pi: ExtensionAPI | null = null;
  private ctx: PiUiContext;
  private liveWidgetState: LiveDeltaWidgetState | null = null;
  private onSettledHandler?: (status: string) => void;

  constructor(options: {
    runId: string;
    metadata: CloudRunSessionMetadata;
    runClient: RunClient;
    ctx: PiUiContext;
    pi?: ExtensionAPI | null;
    cursor?: string;
  }) {
    this.runId = options.runId;
    this.shortRunId = extractShortRunId(options.runId);
    this.metadata = options.metadata;
    this.runClient = options.runClient;
    this.ctx = options.ctx;
    this.pi = options.pi ?? null;
    this.cursor = options.cursor ?? options.metadata.cursor;
  }

  public getAttached(): boolean {
    return this.isAttached;
  }

  public getRunClient(): RunClient {
    return this.runClient;
  }

  public getLiveWidgetState(): LiveDeltaWidgetState | null {
    return this.liveWidgetState;
  }

  public setOnSettled(handler: (status: string) => void): void {
    this.onSettledHandler = handler;
  }

  /**
   * Initializes session binding and begins historical replay and live stream sync.
   */
  public async attach(): Promise<void> {
    this.isAttached = true;

    // 1. Session creation / binding if supported in UI context
    if (this.ctx.hasUI && typeof this.ctx.newSession === "function") {
      try {
        const sessionName = `cloud: ${this.shortRunId}`;
        const newCtx = await this.ctx.newSession({ name: sessionName });
        if (newCtx && typeof newCtx === "object") {
          this.ctx = newCtx as PiUiContext;
        }
      } catch {
        // Fall back to current session
      }
    }

    // 2. Persist cloud-run metadata custom entry
    this.appendCustomEntry("cloud-run", this.metadata);

    // 3. Set initial status badge
    this.updateStatusBadge(this.metadata.status || "running");

    // 4. Replay historical entries from runner
    await this.replayHistoricalEntries();

    // 5. Subscribe to live SSE events
    this.subscribeLiveEvents();
  }

  /**
   * Replays historical entries from GET /v1/entries?since=<cursor>.
   * Strictly suppresses duplicates by tracking seenEntryIds.
   */
  public async replayHistoricalEntries(): Promise<number> {
    try {
      const historical = await this.runClient.getHistoricalEntries(this.cursor);
      let count = 0;

      for (const raw of historical) {
        const entryId = (raw.id as string) || `remote-${Date.now()}-${count}`;
        if (this.seenEntryIds.has(entryId)) {
          continue;
        }

        this.seenEntryIds.add(entryId);
        this.cursor = entryId;
        this.metadata.cursor = entryId;

        const role = (raw.role as "user" | "assistant" | "system" | "tool") || "assistant";
        const msgEntry: CloudMessageEntry = {
          id: entryId,
          runId: this.runId,
          role,
          content: (raw.content as string) || (raw.message as string) || (raw.text as string) || "",
          toolName: raw.toolName as string | undefined,
          toolCallId: raw.toolCallId as string | undefined,
          toolArgs: raw.toolArgs as Record<string, unknown> | undefined,
          toolResult: raw.toolResult,
          details: raw.details as Record<string, unknown> | undefined,
          isError: Boolean(raw.isError || raw.error),
          thinking: raw.thinking as string | undefined,
          timestamp: (raw.timestamp as string) || new Date().toISOString(),
          turnIndex: raw.turnIndex as number | undefined,
        };

        this.appendCustomEntry("cloud-msg", msgEntry);
        count++;
      }

      return count;
    } catch {
      // Replay error handled gracefully (e.g. runner suspended or offline)
      return 0;
    }
  }

  /**
   * Subscribes to SSE event stream from runner with live delta widget rendering.
   */
  public subscribeLiveEvents(): void {
    if (this.sseSubscription) {
      this.sseSubscription.unsubscribe();
      this.sseSubscription = null;
    }

    this.sseSubscription = this.runClient.subscribeEvents({
      cursor: this.cursor,
      onEvent: (envelope: SseEnvelope) => this.handleSseEvent(envelope),
      onError: () => {
        // SSE connection error; client auto-reconnects
      },
      onSettled: (status: string) => {
        this.updateStatusBadge(status);
        this.clearLiveWidget();
        this.onSettledHandler?.(status);
      },
      onClose: () => {
        // SSE closed
      },
    });
  }

  /**
   * Dispatches and processes an individual SSE event from the remote runner.
   */
  public handleSseEvent(envelope: SseEnvelope): void {
    const { id, type, data } = envelope;
    const eventData =
      data && typeof data === "object" ? (data as Record<string, unknown>) : { value: data };

    if (id) {
      this.cursor = id;
      this.metadata.cursor = id;
    }

    switch (type) {
      case "message_start": {
        const role = (eventData.role as string) || "assistant";
        this.liveWidgetState = {
          role,
          text: "",
          timestamp: new Date().toISOString(),
        };
        this.renderLiveWidget();
        break;
      }

      case "message_update": {
        const content = eventData.content;
        let deltaText = "";
        if (typeof content === "string") {
          deltaText = content;
        } else if (Array.isArray(content)) {
          deltaText = content
            .map((c) => (typeof c === "object" && c ? (c as { text?: string }).text || "" : ""))
            .join("");
        }

        if (!this.liveWidgetState) {
          this.liveWidgetState = {
            role: (eventData.role as string) || "assistant",
            text: deltaText,
            timestamp: new Date().toISOString(),
          };
        } else {
          this.liveWidgetState.text = deltaText || this.liveWidgetState.text;
        }
        this.renderLiveWidget();
        break;
      }

      case "tool_execution_start": {
        const toolName = (eventData.toolName as string) || (eventData.name as string) || "tool";
        const toolArgs = (eventData.args as Record<string, unknown>) || {};
        const toolCommand =
          typeof toolArgs.command === "string" ? toolArgs.command : JSON.stringify(toolArgs);

        this.liveWidgetState = {
          role: "tool",
          toolName,
          toolArgs,
          toolCommand,
          elapsedMs: 0,
          timestamp: new Date().toISOString(),
        };
        this.renderLiveWidget();
        break;
      }

      case "tool_execution_end": {
        const entryId = id || `tool-${Date.now()}`;
        if (!this.seenEntryIds.has(entryId)) {
          this.seenEntryIds.add(entryId);
          const toolMsg: CloudMessageEntry = {
            id: entryId,
            runId: this.runId,
            role: "tool",
            content: (eventData.result as string) || "",
            toolName: eventData.toolName as string | undefined,
            toolCallId: eventData.toolCallId as string | undefined,
            toolArgs: eventData.args as Record<string, unknown> | undefined,
            toolResult: eventData.result,
            details: eventData.details as Record<string, unknown> | undefined,
            isError: Boolean(eventData.isError),
            timestamp: new Date().toISOString(),
          };
          this.appendCustomEntry("cloud-msg", toolMsg);
        }
        this.clearLiveWidget();
        break;
      }

      case "message_end":
      case "turn_end": {
        const entryId = id || (eventData.id as string) || `msg-${Date.now()}`;
        if (!this.seenEntryIds.has(entryId)) {
          this.seenEntryIds.add(entryId);
          const content = eventData.content;
          let textContent = "";
          if (typeof content === "string") {
            textContent = content;
          } else if (Array.isArray(content)) {
            textContent = content
              .map((c) => (typeof c === "object" && c ? (c as { text?: string }).text || "" : ""))
              .join("");
          } else if (this.liveWidgetState?.text) {
            textContent = this.liveWidgetState.text;
          }

          const msgEntry: CloudMessageEntry = {
            id: entryId,
            runId: this.runId,
            role: (eventData.role as "user" | "assistant" | "system" | "tool") || "assistant",
            content: textContent,
            thinking: eventData.thinking as string | undefined,
            timestamp: new Date().toISOString(),
            turnIndex: eventData.turnIndex as number | undefined,
          };
          this.appendCustomEntry("cloud-msg", msgEntry);
        }
        this.clearLiveWidget();
        break;
      }

      case "agent_settled": {
        const settledStatus = (eventData.status as string) || "idle";
        this.metadata.status = settledStatus;
        this.updateStatusBadge(settledStatus);
        this.clearLiveWidget();
        if (this.ctx.hasUI && this.ctx.ui?.notify) {
          this.ctx.ui.notify(
            `Cloud agent run '${this.shortRunId}' settled: ${settledStatus}`,
            settledStatus === "completed"
              ? "info"
              : settledStatus === "failed"
                ? "error"
                : "warning",
          );
        }
        break;
      }

      case "status_update":
      case "state_change": {
        const newStatus = (eventData.status as string) || (eventData.state as string) || "running";
        this.metadata.status = newStatus;
        this.updateStatusBadge(newStatus);
        break;
      }
    }
  }

  /**
   * Updates or clears the live delta widget in the UI.
   */
  public renderLiveWidget(): void {
    if (!this.ctx.hasUI || !this.ctx.ui || typeof this.ctx.ui.setWidget !== "function") {
      return;
    }

    if (!this.liveWidgetState) {
      this.ctx.ui.setWidget("cloud-live", undefined);
      return;
    }

    const state = this.liveWidgetState;
    let displayText = "";

    if (state.role === "tool" && state.toolName) {
      displayText = `[tool: ${state.toolName}] ${state.toolCommand || ""}`;
    } else if (state.text) {
      displayText = state.text;
    } else {
      displayText = "Streaming...";
    }

    this.ctx.ui.setWidget("cloud-live", [displayText]);
  }

  /**
   * Clears the active live streaming widget.
   */
  public clearLiveWidget(): void {
    this.liveWidgetState = null;
    if (this.ctx.hasUI && this.ctx.ui && typeof this.ctx.ui.setWidget === "function") {
      this.ctx.ui.setWidget("cloud-live", undefined);
    }
  }

  /**
   * Updates status badge in footer: badge(state).
   */
  public updateStatusBadge(state: string): void {
    if (this.ctx.hasUI && this.ctx.ui && typeof this.ctx.ui.setStatus === "function") {
      const stateBadge = badge(state);
      this.ctx.ui.setStatus("cloud", `cloud ${this.shortRunId} · ${stateBadge}`);
    }
  }

  /**
   * Appends a custom entry to the local pi session.
   */
  public appendCustomEntry(type: string, data: unknown): void {
    if (this.pi && typeof this.pi.appendEntry === "function") {
      try {
        this.pi.appendEntry(type, data);
      } catch {
        // Best effort custom entry
      }
    }
  }

  /**
   * Unbinds mirror session, clears widgets and active subscriptions.
   */
  public detach(): void {
    this.isAttached = false;

    if (this.sseSubscription) {
      this.sseSubscription.unsubscribe();
      this.sseSubscription = null;
    }

    this.clearLiveWidget();

    if (this.ctx.hasUI && this.ctx.ui && typeof this.ctx.ui.setStatus === "function") {
      this.ctx.ui.setStatus("cloud", "cloud 0 running · 0 idle");
    }
  }
}

// ---------------------------------------------------------------------------
// Global Active Mirror Registry
// ---------------------------------------------------------------------------

let activeMirror: MirrorSession | null = null;

export function getActiveMirrorSession(): MirrorSession | null {
  return activeMirror;
}

export function setActiveMirrorSession(session: MirrorSession | null): void {
  activeMirror = session;
}

/**
 * Creates and attaches a new mirror session for target cloud run.
 */
export async function createAndAttachMirrorSession(
  options: MirrorAttachOptions,
): Promise<MirrorSession> {
  const { runId, ctx, pi } = options;
  const config = loadLocalConfig();
  const region = options.region || config.aws.region || "us-east-1";
  const profile = options.profile || config.aws.profile;
  const clientFactory = options.clientFactory || new AwsClientFactory({ region, profile });

  // Resolve status details for run
  const details = await fetchRunStatusDetails(runId, {
    clientFactory,
    fetchFn: options.fetchFn,
  });

  const endpoint = options.endpoint || details.manifest.endpoint;
  const microvmId = options.microvmId || details.manifest.microvmId;

  if (!endpoint) {
    throw new Error(`Run '${runId}' does not have an active endpoint in manifest.`);
  }

  const runClient = new RunClient({
    endpoint,
    microvmIdentifier: microvmId,
    region,
    profile,
    clientFactory,
    fetchFn: options.fetchFn,
  });

  const metadata: CloudRunSessionMetadata = {
    runId: details.runId,
    shortRunId: details.shortRunId,
    cursor: options.cursor,
    owner: options.owner || details.manifest.owner,
    status: details.status,
    createdAt: details.manifest.createdAt,
    endpoint,
    microvmId,
    repo: details.repo.displayRepo,
    model: details.model.displayName,
  };

  // Detach any previous mirror
  if (activeMirror) {
    activeMirror.detach();
  }

  const session = new MirrorSession({
    runId: details.runId,
    metadata,
    runClient,
    ctx,
    pi,
    cursor: options.cursor,
  });

  await session.attach();
  setActiveMirrorSession(session);

  return session;
}

/**
 * Detaches current active mirror session if bound.
 */
export function detachActiveMirrorSession(): boolean {
  if (activeMirror) {
    activeMirror.detach();
    activeMirror = null;
    return true;
  }
  return false;
}

/**
 * Guard hook to prevent local LLM from running inside an active cloud mirror session.
 */
export function beforeAgentStartGuard(): { cancel: boolean; message?: string } {
  if (activeMirror?.getAttached()) {
    return {
      cancel: true,
      message:
        "Local LLM is disabled in cloud mirror session. Use '/cloud detach' to return to local session, or type prompts to forward to the cloud agent.",
    };
  }
  return { cancel: false };
}
