import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiUiContext } from "./prompter-pi.js";
import { getCloudArgumentCompletions, routeCloudCommand } from "./router.js";
import { registerCloudAgentTool } from "./tools/cloud-agent.js";
import { handleSessionShutdownDurability, handleSessionStartDurability } from "./ui/durability.js";
import { registerInputHandling } from "./ui/input-handler.js";
import {
  beforeAgentStartGuard,
  detachActiveMirrorSession,
  getActiveMirrorSession,
} from "./ui/mirror.js";
import { registerCloudRenderers } from "./ui/renderers/cloud-entry.js";

export default function (pi: ExtensionAPI): void {
  // Register custom entry renderers for cloud mirror messages
  registerCloudRenderers(pi);

  // Register input interception and abort shortcut
  registerInputHandling(pi);

  // Register cloud_agent tool for LLM delegation
  registerCloudAgentTool(pi);

  pi.registerCommand("cloud", {
    description: "Manage AWS Lambda MicroVM cloud agents",
    getArgumentCompletions: (prefix: string) => {
      return getCloudArgumentCompletions(prefix, []);
    },
    handler: async (args: string, ctx) => {
      await routeCloudCommand(args, ctx as unknown as PiUiContext);

      // Update footer status badge if UI is active and no mirror session is active
      if (ctx.hasUI && ctx.ui && typeof ctx.ui.setStatus === "function") {
        if (!getActiveMirrorSession()) {
          ctx.ui.setStatus("cloud", "cloud 0 running · 0 idle");
        }
      }
    },
  });

  // Background fleet status polling hook (every 30s when session is active and has UI)
  if (typeof pi.on === "function") {
    pi.on("before_agent_start", (_event, _ctx) => {
      beforeAgentStartGuard();
    });

    let pollInterval: ReturnType<typeof setInterval> | null = null;

    pi.on("session_start", async (event, ctx) => {
      // Auto-reattach if this session contains cloud-run metadata (laptop-close / resume)
      const entries = (event as { entries?: unknown[] })?.entries;
      await handleSessionStartDurability(entries, ctx as unknown as PiUiContext, pi);

      if (ctx.hasUI && ctx.ui && typeof ctx.ui.setStatus === "function") {
        if (!getActiveMirrorSession()) {
          ctx.ui.setStatus("cloud", "cloud 0 running · 0 idle");
        }

        if (!pollInterval) {
          pollInterval = setInterval(() => {
            if (ctx.hasUI && ctx.ui && typeof ctx.ui.setStatus === "function") {
              if (!getActiveMirrorSession()) {
                ctx.ui.setStatus("cloud", "cloud 0 running · 0 idle");
              }
            }
          }, 30_000);
        }
      }
    });

    pi.on("session_shutdown", () => {
      handleSessionShutdownDurability();
      detachActiveMirrorSession();

      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    });
  }
}
