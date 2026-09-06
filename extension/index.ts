import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCloudArgumentCompletions, routeCloudCommand } from "./router.js";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("cloud", {
    description: "Manage AWS Lambda MicroVM cloud agents",
    getArgumentCompletions: (prefix: string) => {
      return getCloudArgumentCompletions(prefix, []);
    },
    handler: async (args: string, ctx) => {
      await routeCloudCommand(args, ctx);

      // Update footer status badge if UI is active
      if (ctx.hasUI && ctx.ui && typeof ctx.ui.setStatus === "function") {
        ctx.ui.setStatus("cloud", "cloud 0 running · 0 idle");
      }
    },
  });

  // Background fleet status polling hook (every 30s when session is active and has UI)
  if (typeof pi.on === "function") {
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI && ctx.ui && typeof ctx.ui.setStatus === "function") {
        ctx.ui.setStatus("cloud", "cloud 0 running · 0 idle");

        if (!pollInterval) {
          pollInterval = setInterval(() => {
            if (ctx.hasUI && ctx.ui && typeof ctx.ui.setStatus === "function") {
              ctx.ui.setStatus("cloud", "cloud 0 running · 0 idle");
            }
          }, 30_000);
        }
      }
    });

    pi.on("session_shutdown", () => {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    });
  }
}
