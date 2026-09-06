import { describe, expect, it, vi } from "vitest";
import registerExtension from "../../extension/index.js";

describe("Extension registration", () => {
  it("registers /cloud command with ExtensionAPI", () => {
    const registeredCommands = new Map<
      string,
      { description?: string; handler: (args: unknown, ctx: unknown) => Promise<void> }
    >();
    const mockPi = {
      registerCommand: vi.fn(
        (
          name: string,
          options: {
            description?: string;
            handler: (args: unknown, ctx: unknown) => Promise<void>;
          },
        ) => {
          registeredCommands.set(name, options);
        },
      ),
    };

    registerExtension(mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);

    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      "cloud",
      expect.objectContaining({
        description: "Manage AWS Lambda MicroVM cloud agents",
      }),
    );

    expect(registeredCommands.has("cloud")).toBe(true);
  });

  it("notifies when handler is executed in UI mode", async () => {
    let handlerFn: ((args: unknown, ctx: unknown) => Promise<void>) | undefined;
    const mockPi = {
      registerCommand: vi.fn(
        (
          _name: string,
          options: {
            description?: string;
            handler: (args: unknown, ctx: unknown) => Promise<void>;
          },
        ) => {
          handlerFn = options.handler;
        },
      ),
    };

    registerExtension(mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
    expect(handlerFn).toBeDefined();

    const notify = vi.fn();
    const ctx = {
      hasUI: true,
      ui: { notify },
    };

    await handlerFn!({}, ctx);
    expect(notify).toHaveBeenCalledWith("pi-cloud-agents loaded");
  });
});
