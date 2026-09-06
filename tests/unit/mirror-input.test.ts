import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunClient } from "../../core/client/run-client.js";
import type { PiUiContext } from "../../extension/prompter-pi.js";
import {
  handleCloudAbortCommand,
  handleMirrorInput,
  handleRemoteUiRequest,
  registerInputHandling,
} from "../../extension/ui/input-handler.js";
import {
  MirrorSession,
  detachActiveMirrorSession,
  setActiveMirrorSession,
} from "../../extension/ui/mirror.js";

describe("T4.7b /cloud attach input forwarding and controls", () => {
  let mockUi: {
    notify: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    setWidget: ReturnType<typeof vi.fn>;
    confirm: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    input: ReturnType<typeof vi.fn>;
  };
  let mockCtx: PiUiContext;
  let mockPi: {
    appendEntry: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    registerShortcut: ReturnType<typeof vi.fn>;
  };
  let mockRunClient: {
    prompt: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockUi = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      confirm: vi.fn().mockResolvedValue(true),
      select: vi.fn().mockResolvedValue("option-a"),
      input: vi.fn().mockResolvedValue("user response"),
    };
    mockCtx = {
      hasUI: true,
      mode: "tui",
      ui: mockUi,
    };
    mockPi = {
      appendEntry: vi.fn(),
      on: vi.fn(),
      registerShortcut: vi.fn(),
    };
    mockRunClient = {
      prompt: vi.fn().mockResolvedValue({ status: "ok" }),
      abort: vi.fn().mockResolvedValue({ aborted: true }),
    };

    setActiveMirrorSession(null);
  });

  afterEach(() => {
    detachActiveMirrorSession();
  });

  it("passes through input when no mirror session is active", async () => {
    const res = await handleMirrorInput({
      text: "Hello local agent",
    });
    expect(res).toEqual({ action: "continue" });
  });

  it("passes through slash commands even when mirror session is active", async () => {
    const session = new MirrorSession({
      runId: "run-7f3a2c",
      metadata: { runId: "run-7f3a2c", shortRunId: "7f3a2c", owner: "user", status: "running" },
      runClient: mockRunClient as unknown as RunClient,
      ctx: mockCtx,
      pi: mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
    });
    (session as unknown as { isAttached: boolean }).isAttached = true;
    setActiveMirrorSession(session);

    const resCloud = await handleMirrorInput({ text: "/cloud list" });
    expect(resCloud).toEqual({ action: "continue" });

    const resHelp = await handleMirrorInput({ text: "/help" });
    expect(resHelp).toEqual({ action: "continue" });
  });

  it("forwards standard prompt input and returns { action: 'handled' }", async () => {
    const session = new MirrorSession({
      runId: "run-7f3a2c",
      metadata: { runId: "run-7f3a2c", shortRunId: "7f3a2c", owner: "user", status: "running" },
      runClient: mockRunClient as unknown as RunClient,
      ctx: mockCtx,
      pi: mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
    });
    (session as unknown as { isAttached: boolean }).isAttached = true;
    setActiveMirrorSession(session);

    const res = await handleMirrorInput({
      text: "Please refactor the database connector",
    });

    expect(res).toEqual({ action: "handled" });
    expect(mockRunClient.prompt).toHaveBeenCalledWith({
      prompt: "Please refactor the database connector",
      mode: "prompt",
      steer: false,
    });
    expect(mockPi.appendEntry).toHaveBeenCalledWith(
      "cloud-msg",
      expect.objectContaining({
        role: "user",
        content: "Please refactor the database connector",
      }),
    );
  });

  it("forwards steer input when streamingBehavior is 'steer'", async () => {
    const session = new MirrorSession({
      runId: "run-7f3a2c",
      metadata: { runId: "run-7f3a2c", shortRunId: "7f3a2c", owner: "user", status: "running" },
      runClient: mockRunClient as unknown as RunClient,
      ctx: mockCtx,
      pi: mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
    });
    (session as unknown as { isAttached: boolean }).isAttached = true;
    setActiveMirrorSession(session);

    const res = await handleMirrorInput({
      text: "Stop editing tests and check the main file instead",
      streamingBehavior: "steer",
    });

    expect(res).toEqual({ action: "handled" });
    expect(mockRunClient.prompt).toHaveBeenCalledWith({
      prompt: "Stop editing tests and check the main file instead",
      mode: "steer",
      steer: true,
    });
  });

  it("forwards followUp input when streamingBehavior is 'followUp'", async () => {
    const session = new MirrorSession({
      runId: "run-7f3a2c",
      metadata: { runId: "run-7f3a2c", shortRunId: "7f3a2c", owner: "user", status: "running" },
      runClient: mockRunClient as unknown as RunClient,
      ctx: mockCtx,
      pi: mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
    });
    (session as unknown as { isAttached: boolean }).isAttached = true;
    setActiveMirrorSession(session);

    const res = await handleMirrorInput({
      text: "Next, run the integration test suite",
      streamingBehavior: "followUp",
    });

    expect(res).toEqual({ action: "handled" });
    expect(mockRunClient.prompt).toHaveBeenCalledWith({
      prompt: "Next, run the integration test suite",
      mode: "followUp",
      steer: false,
    });
  });

  it("handles image attachments in prompt input", async () => {
    const session = new MirrorSession({
      runId: "run-7f3a2c",
      metadata: { runId: "run-7f3a2c", shortRunId: "7f3a2c", owner: "user", status: "running" },
      runClient: mockRunClient as unknown as RunClient,
      ctx: mockCtx,
      pi: mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
    });
    (session as unknown as { isAttached: boolean }).isAttached = true;
    setActiveMirrorSession(session);

    const res = await handleMirrorInput({
      text: "Check this screenshot",
      images: [{ type: "image", mimeType: "image/png" }],
    });

    expect(res).toEqual({ action: "handled" });
    expect(mockRunClient.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Attached 1 image"),
      }),
    );
  });

  it("handles /cloud abort command and dispatches abort to remote runner", async () => {
    const session = new MirrorSession({
      runId: "run-7f3a2c",
      metadata: { runId: "run-7f3a2c", shortRunId: "7f3a2c", owner: "user", status: "running" },
      runClient: mockRunClient as unknown as RunClient,
      ctx: mockCtx,
    });
    (session as unknown as { isAttached: boolean }).isAttached = true;
    setActiveMirrorSession(session);

    const res = await handleCloudAbortCommand([], mockCtx);
    expect(res.handled).toBe(true);
    expect(res.output).toContain("Abort signal sent to cloud agent run '7f3a2c'");
    expect(mockRunClient.abort).toHaveBeenCalled();
  });

  it("handles remote UI requests: confirm, select, and input round-trips", async () => {
    const sendResponseSpy = vi.fn();

    // 1. confirm
    await handleRemoteUiRequest(
      {
        id: "req-1",
        method: "confirm",
        params: { message: "Proceed with database migration?", defaultValue: true },
      },
      mockCtx,
      sendResponseSpy,
    );
    expect(mockUi.confirm).toHaveBeenCalledWith("Proceed with database migration?", true);
    expect(sendResponseSpy).toHaveBeenCalledWith("req-1", true);

    // 2. select
    await handleRemoteUiRequest(
      {
        id: "req-2",
        method: "select",
        params: {
          title: "Select target environment:",
          options: [
            { label: "Option A", value: "option-a" },
            { label: "Option B", value: "option-b" },
          ],
        },
      },
      mockCtx,
      sendResponseSpy,
    );
    expect(mockUi.select).toHaveBeenCalled();
    expect(sendResponseSpy).toHaveBeenCalledWith("req-2", "option-a");

    // 3. input
    await handleRemoteUiRequest(
      {
        id: "req-3",
        method: "input",
        params: { title: "Enter branch name:" },
      },
      mockCtx,
      sendResponseSpy,
    );
    expect(mockUi.input).toHaveBeenCalledWith("Enter branch name:", "");
    expect(sendResponseSpy).toHaveBeenCalledWith("req-3", "user response");
  });

  it("registers input listener and shortcut with ExtensionAPI", () => {
    registerInputHandling(
      mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
    );
    expect(mockPi.on).toHaveBeenCalledWith("input", expect.any(Function));
    expect(mockPi.registerShortcut).toHaveBeenCalledWith(
      "ctrl+alt+c",
      expect.objectContaining({
        description: "Abort active cloud agent turn",
      }),
    );
  });
});
