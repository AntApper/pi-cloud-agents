import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as statusModule from "../../core/status.js";
import type { PiUiContext } from "../../extension/prompter-pi.js";
import {
  autoReattachSession,
  computeReconnectDelay,
  detectCloudRunMetadata,
  handleSessionShutdownDurability,
  handleSessionStartDurability,
} from "../../extension/ui/durability.js";
import {
  type CloudRunSessionMetadata,
  MirrorSession,
  detachActiveMirrorSession,
  getActiveMirrorSession,
  setActiveMirrorSession,
} from "../../extension/ui/mirror.js";

describe("T4.7d Mirror session durability and auto-reattach", () => {
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
    };
    mockPi = {
      appendEntry: vi.fn(),
    };
    setActiveMirrorSession(null);
  });

  afterEach(() => {
    detachActiveMirrorSession();
    vi.restoreAllMocks();
  });

  it("computes exponential backoff delay with bounded jitter and max delay cap", () => {
    const delay0 = computeReconnectDelay(0, 500, 10000);
    expect(delay0).toBeGreaterThanOrEqual(100);
    expect(delay0).toBeLessThanOrEqual(1000);

    const delay5 = computeReconnectDelay(5, 500, 10000);
    expect(delay5).toBeGreaterThan(delay0);

    const delayLarge = computeReconnectDelay(20, 500, 10000);
    expect(delayLarge).toBeLessThanOrEqual(15000);
  });

  it("detects cloud-run metadata from session entries", () => {
    // When no cloud-run entry
    const entriesWithout = [
      { type: "message", role: "user", content: "hello" },
      { type: "message", role: "assistant", content: "hi" },
    ];
    expect(detectCloudRunMetadata(entriesWithout)).toBeNull();

    // When cloud-run entry is present
    const entriesWith = [
      { type: "message", role: "user", content: "hello" },
      {
        customType: "cloud-run",
        data: {
          runId: "run-20260906-7f3a2c",
          shortRunId: "7f3a2c",
          cursor: "msg-123",
          owner: "test-user",
          status: "running",
          endpoint: "localhost:8080",
        },
      },
    ];

    const detected = detectCloudRunMetadata(entriesWith);
    expect(detected).not.toBeNull();
    expect(detected?.runId).toBe("run-20260906-7f3a2c");
    expect(detected?.shortRunId).toBe("7f3a2c");
    expect(detected?.cursor).toBe("msg-123");
    expect(detected?.owner).toBe("test-user");
  });

  it("auto-reattaches to running MicroVM session and replays missed entries", async () => {
    const metadata: CloudRunSessionMetadata = {
      runId: "run-20260906-7f3a2c",
      shortRunId: "7f3a2c",
      cursor: "msg-001",
      owner: "test-user",
      status: "running",
      endpoint: "localhost:8080",
    };

    const mockDetails = {
      runId: "run-20260906-7f3a2c",
      shortRunId: "7f3a2c",
      status: "running",
      manifest: {
        runId: "run-20260906-7f3a2c",
        owner: "test-user",
        status: "running",
        endpoint: "localhost:8080",
        microvmId: "mvm-12345",
      },
      repo: { displayRepo: "acme/repo#main" },
      model: { displayName: "sonnet-4-5" },
    };

    vi.spyOn(statusModule, "fetchRunStatusDetails").mockResolvedValue(
      mockDetails as unknown as statusModule.RunStatusDetails,
    );

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/v1/entries")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          text: () =>
            Promise.resolve(
              JSON.stringify({
                entries: [{ id: "msg-002", role: "assistant", content: "New remote message" }],
              }),
            ),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve("{}"),
      });
    });

    const session = await autoReattachSession(
      metadata,
      mockCtx,
      mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
      { fetchFn: mockFetch as unknown as typeof fetch },
    );

    expect(session).not.toBeNull();
    expect(getActiveMirrorSession()).toBe(session);
    expect(mockUi.setStatus).toHaveBeenCalledWith(
      "cloud",
      expect.stringContaining("reconnecting..."),
    );
    expect(mockUi.setStatus).toHaveBeenCalledWith("cloud", expect.stringContaining("● running"));
  });

  it("handles auto-reattach to suspended MicroVM and indicates resuming status", async () => {
    const metadata: CloudRunSessionMetadata = {
      runId: "run-20260906-7f3a2c",
      shortRunId: "7f3a2c",
      owner: "test-user",
      status: "suspended",
      endpoint: "localhost:8080",
    };

    const mockDetails = {
      runId: "run-20260906-7f3a2c",
      shortRunId: "7f3a2c",
      status: "suspended",
      manifest: {
        runId: "run-20260906-7f3a2c",
        owner: "test-user",
        status: "suspended",
        endpoint: "localhost:8080",
      },
      repo: { displayRepo: "acme/repo#main" },
      model: { displayName: "sonnet-4-5" },
    };

    vi.spyOn(statusModule, "fetchRunStatusDetails").mockResolvedValue(
      mockDetails as unknown as statusModule.RunStatusDetails,
    );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(JSON.stringify({ entries: [] })),
    });

    const session = await autoReattachSession(
      metadata,
      mockCtx,
      mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
      { fetchFn: mockFetch as unknown as typeof fetch },
    );

    expect(session).not.toBeNull();
    expect(mockUi.setStatus).toHaveBeenCalledWith(
      "cloud",
      expect.stringContaining("resuming MicroVM..."),
    );
    expect(mockUi.notify).toHaveBeenCalledWith(
      expect.stringContaining("is suspended. Resuming MicroVM"),
      "info",
    );
  });

  it("handles auto-reattach to terminated run and notifies with final status", async () => {
    const metadata: CloudRunSessionMetadata = {
      runId: "run-20260906-7f3a2c",
      shortRunId: "7f3a2c",
      owner: "test-user",
      status: "completed",
      endpoint: "localhost:8080",
    };

    const mockDetails = {
      runId: "run-20260906-7f3a2c",
      shortRunId: "7f3a2c",
      status: "completed",
      manifest: {
        runId: "run-20260906-7f3a2c",
        owner: "test-user",
        status: "completed",
        endpoint: "localhost:8080",
      },
      repo: { displayRepo: "acme/repo#main" },
      model: { displayName: "sonnet-4-5" },
    };

    vi.spyOn(statusModule, "fetchRunStatusDetails").mockResolvedValue(
      mockDetails as unknown as statusModule.RunStatusDetails,
    );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(JSON.stringify({ entries: [] })),
    });

    const session = await autoReattachSession(
      metadata,
      mockCtx,
      mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
      { fetchFn: mockFetch as unknown as typeof fetch },
    );

    expect(session).not.toBeNull();
    expect(mockUi.setStatus).toHaveBeenCalledWith("cloud", expect.stringContaining("✓ completed"));
    expect(mockUi.notify).toHaveBeenCalledWith(
      expect.stringContaining("has finished (completed)"),
      "info",
    );
  });

  it("triggers handleSessionStartDurability on session_start event", async () => {
    const sessionEntries = [
      {
        customType: "cloud-run",
        data: {
          runId: "run-20260906-7f3a2c",
          shortRunId: "7f3a2c",
          owner: "test-user",
          status: "running",
          endpoint: "localhost:8080",
        },
      },
    ];

    const mockDetails = {
      runId: "run-20260906-7f3a2c",
      shortRunId: "7f3a2c",
      status: "running",
      manifest: {
        runId: "run-20260906-7f3a2c",
        owner: "test-user",
        status: "running",
        endpoint: "localhost:8080",
      },
      repo: { displayRepo: "acme/repo#main" },
      model: { displayName: "sonnet-4-5" },
    };

    vi.spyOn(statusModule, "fetchRunStatusDetails").mockResolvedValue(
      mockDetails as unknown as statusModule.RunStatusDetails,
    );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(JSON.stringify({ entries: [] })),
    });

    const session = await handleSessionStartDurability(
      sessionEntries,
      mockCtx,
      mockPi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
      { fetchFn: mockFetch as unknown as typeof fetch },
    );

    expect(session).not.toBeNull();
    expect(getActiveMirrorSession()).toBe(session);
  });

  it("cleans up active mirror session cleanly on handleSessionShutdownDurability", () => {
    const session = new MirrorSession({
      runId: "run-7f3a2c",
      metadata: { runId: "run-7f3a2c", shortRunId: "7f3a2c", owner: "user", status: "running" },
      runClient: {
        subscribeEvents: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
      } as unknown as import("../../core/client/run-client.js").RunClient,
      ctx: mockCtx,
    });
    (session as unknown as { isAttached: boolean }).isAttached = true;
    setActiveMirrorSession(session);

    handleSessionShutdownDurability();
    expect(getActiveMirrorSession()).toBeNull();
  });
});
