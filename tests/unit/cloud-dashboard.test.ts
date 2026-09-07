/**
 * Unit tests for Cloud Dashboard live fleet view (T4.14).
 */

import { describe, expect, it } from "vitest";
import {
  type DashboardData,
  computeFleetSummary,
  formatDashboardView,
} from "../../core/dashboard.js";
import type { RunListItem } from "../../core/list.js";

describe("T4.14 Cloud Dashboard Live Fleet View", () => {
  const mockRuns: RunListItem[] = [
    {
      runId: "run-20260906-abc001",
      fullRunId: "run-20260906-abc001",
      status: "running",
      statusBadge: "● running",
      repo: "acme/api",
      workBranch: "pi-cloud/abc001",
      model: "anthropic/claude-sonnet-4-5",
      turns: 8,
      tokens: "45k",
      tokensCount: 45000,
      cost: "$0.12 est.",
      costUsd: 0.12,
      elapsed: "18m 20s",
      elapsedMs: 1100000,
      lastEventAge: "12s ago",
      lastEventAgeSeconds: 12,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activity: "Executing bash command",
      manifest: {
        v: 1,
        runId: "run-20260906-abc001",
        owner: "user",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        imageVersion: "1.0",
        repo: { url: "https://github.com/acme/api", workBranch: "pi-cloud/abc001" },
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        timeline: [],
      },
    },
    {
      runId: "run-20260906-abc002",
      fullRunId: "run-20260906-abc002",
      status: "idle",
      statusBadge: "○ idle",
      repo: "acme/web",
      workBranch: "pi-cloud/abc002",
      model: "openai/gpt-4o",
      turns: 12,
      tokens: "60k",
      tokensCount: 60000,
      cost: "$0.18 est.",
      costUsd: 0.18,
      elapsed: "35m 10s",
      elapsedMs: 2110000,
      lastEventAge: "3m ago",
      lastEventAgeSeconds: 180,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activity: "Waiting for user input",
      manifest: {
        v: 1,
        runId: "run-20260906-abc002",
        owner: "user",
        status: "idle",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        imageVersion: "1.0",
        repo: { url: "https://github.com/acme/web", workBranch: "pi-cloud/abc002" },
        model: { provider: "openai", id: "gpt-4o" },
        timeline: [],
      },
    },
    {
      runId: "run-20260906-abc003",
      fullRunId: "run-20260906-abc003",
      status: "completed",
      statusBadge: "✓ completed",
      repo: "acme/core",
      workBranch: "pi-cloud/abc003",
      model: "anthropic/claude-sonnet-4-5",
      turns: 15,
      tokens: "80k",
      tokensCount: 80000,
      cost: "$0.25 est.",
      costUsd: 0.25,
      elapsed: "45m 00s",
      elapsedMs: 2700000,
      lastEventAge: "10m ago",
      lastEventAgeSeconds: 600,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activity: "Done",
      manifest: {
        v: 1,
        runId: "run-20260906-abc003",
        owner: "user",
        status: "completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        imageVersion: "1.0",
        repo: { url: "https://github.com/acme/core", workBranch: "pi-cloud/abc003" },
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        timeline: [],
      },
    },
  ];

  it("computes fleet summary metrics correctly", () => {
    const summary = computeFleetSummary(mockRuns);

    expect(summary.totalRunsCount).toBe(3);
    expect(summary.runningCount).toBe(1);
    expect(summary.idleCount).toBe(1);
    expect(summary.completedCount).toBe(1);
    expect(summary.failedCount).toBe(0);
    expect(summary.launchSuccessRatePct).toBe(100);
    expect(summary.estSpendMonthUsd).toBeCloseTo(0.55, 2);
  });

  it("formats responsive dashboard layout within column bounds", () => {
    const summary = computeFleetSummary(mockRuns);
    const mockData: DashboardData = {
      summary,
      activeRuns: mockRuns.slice(0, 2),
      recentRuns: mockRuns,
      activityFeed: [
        {
          timestamp: new Date().toISOString(),
          relativeAge: "10s ago",
          runId: "run-abc001",
          shortRunId: "run-abc0",
          action: "Running bash tool",
          status: "info",
        },
      ],
      updatedAt: new Date().toISOString(),
    };

    const formatted80 = formatDashboardView(mockData, 80);
    expect(formatted80).toContain("Fleet Dashboard");
    expect(formatted80).toContain("ACTIVE RUNS");
    expect(formatted80).toContain("RECENT ACTIVITY FEED");

    const lines = formatted80.split("\n");
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(84);
    }
  });
});
