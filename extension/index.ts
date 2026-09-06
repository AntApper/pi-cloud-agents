import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("cloud", {
    description: "Manage AWS Lambda MicroVM cloud agents",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify("pi-cloud-agents loaded");
      }
    },
  });
}
