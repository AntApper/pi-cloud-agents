/**
 * Cloud Agent Input Forwarding, Abort, and Remote UI Interaction (T4.7b).
 * Intercepts user input in active mirror sessions, maps streamingBehavior
 * (prompt, steer, followUp), handles abort control, and resolves remote UI requests.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PromptRequest } from "../../shared/protocol.js";
import { PiPrompter, type PiUiContext } from "../prompter-pi.js";
import type { RouteContext, RouteResult } from "../router.js";
import { type MirrorSession, getActiveMirrorSession } from "./mirror.js";

export interface InputEventPayload {
  text: string;
  images?: unknown[];
  source?: string;
  streamingBehavior?: "steer" | "followUp";
}

export type InputHandleResult =
  | { action: "continue" }
  | { action: "handled" }
  | { action: "transform"; text: string };

export interface RemoteUiRequestPayload {
  id: string;
  method: "confirm" | "select" | "input" | string;
  params?: {
    title?: string;
    message?: string;
    options?: Array<{ label: string; value: unknown }>;
    defaultValue?: unknown;
    [key: string]: unknown;
  };
}

/**
 * Handles remote extension UI requests by prompting local user and sending response.
 */
export async function handleRemoteUiRequest(
  request: RemoteUiRequestPayload,
  ctx: PiUiContext,
  sendResponse: (id: string, response: unknown) => void,
): Promise<void> {
  const { id, method, params } = request;
  const prompter = new PiPrompter(ctx);
  const title = params?.title || params?.message || "Cloud Agent Prompt:";

  try {
    let result: unknown;

    switch (method) {
      case "confirm": {
        const defaultVal = typeof params?.defaultValue === "boolean" ? params.defaultValue : true;
        result = await prompter.confirm(title, defaultVal);
        break;
      }

      case "select": {
        const options = (params?.options || []).map((o) => ({
          label: o.label,
          value: o.value,
        }));
        result = await prompter.select(title, options, params?.defaultValue);
        break;
      }

      case "input": {
        const defaultVal = typeof params?.defaultValue === "string" ? params.defaultValue : "";
        result = await prompter.input(title, { defaultValue: defaultVal });
        break;
      }

      default:
        result = undefined;
        break;
    }

    sendResponse(id, result);
  } catch (_err) {
    sendResponse(id, null);
  }
}

/**
 * Intercepts pi `input` event and forwards to cloud runner if attached.
 */
export async function handleMirrorInput(
  event: InputEventPayload,
  session?: MirrorSession | null,
): Promise<InputHandleResult> {
  const activeSession = session ?? getActiveMirrorSession();

  // If no active attached mirror session, pass through to pi
  if (!activeSession || !activeSession.getAttached()) {
    return { action: "continue" };
  }

  const trimmed = (event.text || "").trim();

  // Pass through all slash commands (e.g. /cloud, /help, /settings)
  if (trimmed.startsWith("/")) {
    return { action: "continue" };
  }

  // Determine mode and flags from streamingBehavior
  let mode: "prompt" | "steer" | "followUp" = "prompt";
  let isSteer = false;

  if (event.streamingBehavior === "steer") {
    mode = "steer";
    isSteer = true;
  } else if (event.streamingBehavior === "followUp") {
    mode = "followUp";
  }

  // Format prompt payload
  let promptText = event.text;
  if (event.images && event.images.length > 0) {
    // If images are attached, encode inline reference
    const imageCount = event.images.length;
    promptText = `${event.text}\n[Attached ${imageCount} image${imageCount > 1 ? "s" : ""}]`;
  }

  const promptReq: PromptRequest = {
    prompt: promptText,
    mode,
    steer: isSteer,
  };

  try {
    const runClient = activeSession.getRunClient();
    await runClient.prompt(promptReq);

    // Append user input entry into local mirror session
    activeSession.appendCustomEntry("cloud-msg", {
      id: `user-${Date.now()}`,
      runId: activeSession.runId,
      role: "user",
      content: event.text,
      timestamp: new Date().toISOString(),
    });

    return { action: "handled" };
  } catch (err: unknown) {
    // Error forwarding prompt
    activeSession.appendCustomEntry("cloud-msg", {
      id: `err-${Date.now()}`,
      runId: activeSession.runId,
      role: "system",
      content: `Failed to forward prompt to cloud agent: ${(err as Error).message}`,
      isError: true,
      timestamp: new Date().toISOString(),
    });

    return { action: "handled" };
  }
}

/**
 * /cloud abort [runId]
 */
export async function handleCloudAbortCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  const activeSession = getActiveMirrorSession();
  const runId = subArgs[0]?.trim() || activeSession?.shortRunId;

  if (!activeSession && !subArgs[0]) {
    const notice = "No cloud mirror session currently active. Usage: /cloud abort <runId>";
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(notice, "warning");
    }
    return { subcommand: "abort", args: subArgs, output: notice, handled: true };
  }

  try {
    if (activeSession) {
      await activeSession.getRunClient().abort("User requested abort");
    }

    const output = `✓ Abort signal sent to cloud agent run '${runId}'.`;
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(output, "info");
    }

    return { subcommand: "abort", args: subArgs, output, handled: true };
  } catch (err: unknown) {
    const errorMsg = `Failed to abort run '${runId}': ${(err as Error).message}`;
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(errorMsg, "error");
    }
    return { subcommand: "abort", args: subArgs, output: errorMsg, handled: true };
  }
}

/**
 * Registers input handler and abort shortcuts with pi ExtensionAPI.
 */
export function registerInputHandling(pi: ExtensionAPI): void {
  if (typeof pi.on === "function") {
    pi.on("input", async (event) => {
      const res = await handleMirrorInput({
        text: event.text,
        images: event.images,
        source: event.source,
        streamingBehavior: event.streamingBehavior,
      });
      return res;
    });
  }

  if (typeof pi.registerShortcut === "function") {
    // Register ctrl+alt+c shortcut for aborting cloud agent turn
    try {
      type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];
      pi.registerShortcut("ctrl+alt+c" as unknown as ShortcutKey, {
        description: "Abort active cloud agent turn",
        handler: async (ctx) => {
          await handleCloudAbortCommand([], ctx as unknown as RouteContext);
        },
      });
    } catch {
      // Shortcut registration optional
    }
  }
}
