/**
 * Mirror Session Durability & Auto-Reattach Engine (T4.7d).
 * Manages auto-reattach on session_start (startup, -c, /resume),
 * suspended MicroVM wake-up handling, terminated run detection,
 * exponential reconnection backoff with jitter on network sleep/drop,
 * and clean stream closure on session_shutdown.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AwsClientFactory } from "../../core/aws/clients.js";
import { RunClient } from "../../core/client/run-client.js";
import { loadLocalConfig } from "../../core/config.js";
import { fetchRunStatusDetails } from "../../core/status.js";
import type { PiUiContext } from "../prompter-pi.js";
import {
  type CloudRunSessionMetadata,
  MirrorSession,
  getActiveMirrorSession,
  setActiveMirrorSession,
} from "./mirror.js";

export interface DurabilityReattachOptions {
  clientFactory?: AwsClientFactory;
  fetchFn?: typeof fetch;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

/**
 * Computes exponential backoff delay with jitter.
 */
export function computeReconnectDelay(attempt: number, baseMs = 500, maxMs = 15000): number {
  const exp = Math.min(baseMs * 1.5 ** attempt, maxMs);
  const jitter = (Math.random() * 0.4 - 0.2) * exp;
  return Math.max(100, Math.round(exp + jitter));
}

/**
 * Inspects session context or entry array to discover `cloud-run` metadata.
 */
export function detectCloudRunMetadata(
  entries?: Array<{ customType?: string; type?: string; data?: unknown; [key: string]: unknown }>,
): CloudRunSessionMetadata | null {
  if (!entries || !Array.isArray(entries)) {
    return null;
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const customType = entry.customType || entry.type;
    if (customType === "cloud-run" && entry.data && typeof entry.data === "object") {
      const data = entry.data as Record<string, unknown>;
      if (typeof data.runId === "string") {
        return {
          runId: data.runId,
          shortRunId: (data.shortRunId as string) || data.runId.replace(/^run-/, "").slice(0, 8),
          cursor: data.cursor as string | undefined,
          owner: (data.owner as string) || "user",
          status: (data.status as string) || "running",
          createdAt: data.createdAt as string | undefined,
          endpoint: data.endpoint as string | undefined,
          microvmId: data.microvmId as string | undefined,
          repo: data.repo as string | undefined,
          model: data.model as string | undefined,
        };
      }
    }
  }

  return null;
}

/**
 * Executes automatic reattach to a discovered cloud run session.
 */
export async function autoReattachSession(
  metadata: CloudRunSessionMetadata,
  ctx: PiUiContext,
  pi?: ExtensionAPI | null,
  options: DurabilityReattachOptions = {},
): Promise<MirrorSession | null> {
  const shortId = metadata.shortRunId;

  // 1. Initial status indication: reconnecting
  if (ctx.hasUI && ctx.ui && typeof ctx.ui.setStatus === "function") {
    ctx.ui.setStatus("cloud", `cloud ${shortId} · ◐ reconnecting...`);
  }

  try {
    const config = loadLocalConfig();
    const region = config.aws.region || "us-east-1";
    const profile = config.aws.profile;
    const clientFactory = options.clientFactory || new AwsClientFactory({ region, profile });

    // 2. Fetch latest status details
    const details = await fetchRunStatusDetails(metadata.runId, {
      clientFactory,
      fetchFn: options.fetchFn,
    });

    const isSuspended =
      details.status === "suspended" || details.liveStatus?.status === "suspended";
    const isTerminated =
      details.status === "terminated" ||
      details.status === "completed" ||
      details.status === "failed";

    // 3. Handle suspended MicroVM
    if (isSuspended) {
      if (ctx.hasUI && ctx.ui && typeof ctx.ui.setStatus === "function") {
        ctx.ui.setStatus("cloud", `cloud ${shortId} · ◐ resuming MicroVM...`);
      }
      if (ctx.hasUI && ctx.ui?.notify) {
        ctx.ui.notify(
          `Cloud run '${shortId}' is suspended. Resuming MicroVM on first request...`,
          "info",
        );
      }
    }

    // 4. Handle terminated run
    if (isTerminated) {
      if (ctx.hasUI && ctx.ui && typeof ctx.ui.setStatus === "function") {
        const badgeWord = details.status === "completed" ? "✓ completed" : "· terminated";
        ctx.ui.setStatus("cloud", `cloud ${shortId} · ${badgeWord}`);
      }
      if (ctx.hasUI && ctx.ui?.notify) {
        ctx.ui.notify(
          `Cloud run '${shortId}' has finished (${details.status}). Launch a new run with '/cloud new'.`,
          details.status === "completed" ? "info" : "warning",
        );
      }
    }

    const endpoint = details.manifest.endpoint || metadata.endpoint;
    const microvmId = details.manifest.microvmId || metadata.microvmId;

    if (!endpoint) {
      return null;
    }

    const runClient = new RunClient({
      endpoint,
      microvmIdentifier: microvmId,
      region,
      profile,
      clientFactory,
      fetchFn: options.fetchFn,
    });

    const sessionMetadata: CloudRunSessionMetadata = {
      runId: details.runId,
      shortRunId: details.shortRunId,
      cursor: metadata.cursor,
      owner: details.manifest.owner,
      status: details.status,
      createdAt: details.manifest.createdAt,
      endpoint,
      microvmId,
      repo: details.repo.displayRepo,
      model: details.model.displayName,
    };

    const session = new MirrorSession({
      runId: details.runId,
      metadata: sessionMetadata,
      runClient,
      ctx,
      pi,
      cursor: metadata.cursor,
    });

    // Replay any entries missed since last saved cursor
    await session.replayHistoricalEntries();

    if (!isTerminated) {
      session.subscribeLiveEvents();
    }

    (session as unknown as { isAttached: boolean }).isAttached = true;
    setActiveMirrorSession(session);
    session.updateStatusBadge(details.status);

    return session;
  } catch (_err: unknown) {
    if (ctx.hasUI && ctx.ui && typeof ctx.ui.setStatus === "function") {
      ctx.ui.setStatus("cloud", `cloud ${shortId} · ▲ disconnected`);
    }
    return null;
  }
}

/**
 * Handles `session_start` event to auto-reattach if bound session metadata exists.
 */
export async function handleSessionStartDurability(
  sessionEntries?: unknown[],
  ctx?: PiUiContext,
  pi?: ExtensionAPI | null,
  options?: DurabilityReattachOptions,
): Promise<MirrorSession | null> {
  if (!ctx) return null;

  const metadata = detectCloudRunMetadata(
    sessionEntries as Array<{ customType?: string; type?: string; data?: unknown }> | undefined,
  );
  if (!metadata) {
    return null;
  }

  return autoReattachSession(metadata, ctx, pi, options);
}

/**
 * Handles `session_shutdown` to cleanly flush active connections.
 */
export function handleSessionShutdownDurability(): void {
  const activeSession = getActiveMirrorSession();
  if (activeSession) {
    activeSession.detach();
    setActiveMirrorSession(null);
  }
}
