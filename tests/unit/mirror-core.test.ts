import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunClient } from "../../core/client/run-client.js";
import { handleCloudDetachCommand } from "../../extension/commands/attach.js";
import type { PiUiContext } from "../../extension/prompter-pi.js";
import {
  type CloudRunSessionMetadata,
  MirrorSession,
  beforeAgentStartGuard,
  detachActiveMirrorSession,
  getActiveMirrorSession,
  setActiveMirrorSession,
} from "../../extension/ui/mirror.js";

describe("T4.7a /cloud attach mirror session core", () => {
  let mockUi: {
    notify: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    setWidget: ReturnType<typeof vi.fn>;
  };
  let mockCtx: PiUiContext;
  let mockPi: {
    appendEntry: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockUi = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    mockCtx = {
      hasUI: true,
      mode: "tui",
      ui: mockUi,
      newSession: vi.fn().mockResolvedValue(undefined),
    };
    mockPi = {
      appendEntry: vi.fn(),
    };
    setActiveMirrorSession(null);
  });

  afterEach(() => {
    detachActiveMirrorSession();
  });

  it("initializes MirrorSession, binds session name, appends metadata and sets status", async () => {
    const runId = "run-20260906-7f3a2c";
    const metadata: CloudRunSessionMetadata = {
      runId,
      shortRunId: "7f3a2c",
      owner: "user123",
      status: "running",
      endpoint: "localhost:8080",
    };

    const mockRunClient = {
      getHistoricalEntries: vi.fn().mockResolvedValue([]),
      subscribeEvents: vi.fn().mockReturnValue({
        unsubscribe: vi.fn(),
        getLastCursor: vi.fn(),
      }),
    } as unknown as RunClient;

    const session = new MirrorSession({
      runId,
      metadata,
      runClient: mockRunClient,
      ctx: mockCtx,
      pi: mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
    });

    await session.attach();

    expect(mockCtx.newSession).toHaveBeenCalledWith({ name: "cloud: 7f3a2c" });
    expect(mockPi.appendEntry).toHaveBeenCalledWith("cloud-run", metadata);
    expect(mockUi.setStatus).toHaveBeenCalledWith("cloud", "cloud 7f3a2c · ● running");
    expect(session.getAttached()).toBe(true);
  });

  it("replays historical entries and strictly suppresses duplicates", async () => {
    const runId = "run-20260906-7f3a2c";
    const metadata: CloudRunSessionMetadata = {
      runId,
      shortRunId: "7f3a2c",
      owner: "user123",
      status: "running",
    };

    const entriesFixture = [
      {
        id: "msg-001",
        role: "user",
        content: "Please build feature X",
        timestamp: "2026-09-06T12:00:00.000Z",
      },
      {
        id: "msg-002",
        role: "assistant",
        content: "I will implement feature X now.",
        timestamp: "2026-09-06T12:00:05.000Z",
      },
    ];

    const mockRunClient = {
      getHistoricalEntries: vi.fn().mockResolvedValue(entriesFixture),
      subscribeEvents: vi.fn().mockReturnValue({
        unsubscribe: vi.fn(),
        getLastCursor: vi.fn(),
      }),
    } as unknown as RunClient;

    const session = new MirrorSession({
      runId,
      metadata,
      runClient: mockRunClient,
      ctx: mockCtx,
      pi: mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
    });

    const replayedFirst = await session.replayHistoricalEntries();
    expect(replayedFirst).toBe(2);
    expect(session.seenEntryIds.size).toBe(2);
    expect(session.cursor).toBe("msg-002");

    // Second replay with overlapping items should append 0 duplicates
    const replayedSecond = await session.replayHistoricalEntries();
    expect(replayedSecond).toBe(0);
    expect(mockPi.appendEntry).toHaveBeenCalledTimes(2);
  });

  it("handles live streaming SSE events: updates live delta widget and finalizes turns", async () => {
    const runId = "run-20260906-7f3a2c";
    const metadata: CloudRunSessionMetadata = {
      runId,
      shortRunId: "7f3a2c",
      owner: "user123",
      status: "running",
    };

    let onEventHandler:
      | ((event: import("../../shared/protocol.js").SseEnvelope) => void)
      | undefined;

    const mockRunClient = {
      getHistoricalEntries: vi.fn().mockResolvedValue([]),
      subscribeEvents: vi.fn().mockImplementation((opts) => {
        onEventHandler = opts.onEvent;
        return {
          unsubscribe: vi.fn(),
          getLastCursor: vi.fn(),
        };
      }),
    } as unknown as RunClient;

    const session = new MirrorSession({
      runId,
      metadata,
      runClient: mockRunClient,
      ctx: mockCtx,
      pi: mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
    });

    await session.attach();
    expect(onEventHandler).toBeDefined();

    // 1. message_start
    onEventHandler!({
      id: "evt-1",
      type: "message_start",
      data: { role: "assistant" },
    });
    expect(mockUi.setWidget).toHaveBeenCalledWith("cloud-live", ["Streaming..."]);

    // 2. message_update deltas
    onEventHandler!({
      id: "evt-2",
      type: "message_update",
      data: { content: "Thinking through implementation..." },
    });
    expect(mockUi.setWidget).toHaveBeenCalledWith("cloud-live", [
      "Thinking through implementation...",
    ]);

    // 3. tool_execution_start
    onEventHandler!({
      id: "evt-3",
      type: "tool_execution_start",
      data: { toolName: "bash", args: { command: "npm test" } },
    });
    expect(mockUi.setWidget).toHaveBeenCalledWith("cloud-live", ["[tool: bash] npm test"]);

    // 4. tool_execution_end
    onEventHandler!({
      id: "evt-4",
      type: "tool_execution_end",
      data: { toolName: "bash", result: "PASS: 10 tests" },
    });
    expect(mockUi.setWidget).toHaveBeenCalledWith("cloud-live", undefined);
    expect(mockPi.appendEntry).toHaveBeenCalledWith(
      "cloud-msg",
      expect.objectContaining({
        role: "tool",
        toolName: "bash",
        content: "PASS: 10 tests",
      }),
    );

    // 5. message_end
    onEventHandler!({
      id: "evt-5",
      type: "message_end",
      data: { role: "assistant", content: "All tests pass!" },
    });
    expect(mockUi.setWidget).toHaveBeenCalledWith("cloud-live", undefined);
    expect(mockPi.appendEntry).toHaveBeenCalledWith(
      "cloud-msg",
      expect.objectContaining({
        role: "assistant",
        content: "All tests pass!",
      }),
    );

    // 6. agent_settled
    onEventHandler!({
      id: "evt-6",
      type: "agent_settled",
      data: { status: "completed" },
    });
    expect(mockUi.setStatus).toHaveBeenCalledWith("cloud", "cloud 7f3a2c · ✓ completed");
    expect(mockUi.notify).toHaveBeenCalledWith(
      expect.stringContaining("settled: completed"),
      "info",
    );
  });

  it("enforces local LLM safety guard when mirror is active and allows when detached", () => {
    // When no mirror is active
    expect(beforeAgentStartGuard()).toEqual({ cancel: false });

    // When mirror is active
    const session = new MirrorSession({
      runId: "run-7f3a2c",
      metadata: { runId: "run-7f3a2c", shortRunId: "7f3a2c", owner: "user", status: "running" },
      runClient: {} as RunClient,
      ctx: mockCtx,
    });
    (session as unknown as { isAttached: boolean }).isAttached = true;
    setActiveMirrorSession(session);

    const guardResult = beforeAgentStartGuard();
    expect(guardResult.cancel).toBe(true);
    expect(guardResult.message).toContain("Local LLM is disabled");

    // After detach
    session.detach();
    expect(beforeAgentStartGuard()).toEqual({ cancel: false });
  });

  it("unsubscribes streams, clears widgets and resets footer on detach", () => {
    const unsubSpy = vi.fn();
    const mockRunClient = {
      getHistoricalEntries: vi.fn().mockResolvedValue([]),
      subscribeEvents: vi.fn().mockReturnValue({
        unsubscribe: unsubSpy,
        getLastCursor: vi.fn(),
      }),
    } as unknown as RunClient;

    const session = new MirrorSession({
      runId: "run-7f3a2c",
      metadata: { runId: "run-7f3a2c", shortRunId: "7f3a2c", owner: "user", status: "running" },
      runClient: mockRunClient,
      ctx: mockCtx,
    });

    session.subscribeLiveEvents();
    (session as unknown as { isAttached: boolean }).isAttached = true;

    session.detach();

    expect(unsubSpy).toHaveBeenCalled();
    expect(mockUi.setWidget).toHaveBeenCalledWith("cloud-live", undefined);
    expect(mockUi.setStatus).toHaveBeenCalledWith("cloud", "cloud 0 running · 0 idle");
    expect(session.getAttached()).toBe(false);
  });

  it("executes /cloud detach command cleanly", async () => {
    // When nothing attached
    const resNone = await handleCloudDetachCommand([], mockCtx);
    expect(resNone.handled).toBe(true);
    expect(resNone.output).toContain("No cloud mirror session");

    // When attached
    const session = new MirrorSession({
      runId: "run-7f3a2c",
      metadata: { runId: "run-7f3a2c", shortRunId: "7f3a2c", owner: "user", status: "running" },
      runClient: {
        subscribeEvents: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
      } as unknown as RunClient,
      ctx: mockCtx,
    });
    (session as unknown as { isAttached: boolean }).isAttached = true;
    setActiveMirrorSession(session);

    const resDetach = await handleCloudDetachCommand([], mockCtx);
    expect(resDetach.handled).toBe(true);
    expect(resDetach.output).toContain("Detached mirror session from cloud run '7f3a2c'");
    expect(getActiveMirrorSession()).toBeNull();
  });
});
