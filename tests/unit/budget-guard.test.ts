/**
 * Unit tests for Cost and Budget Guard (T5.4).
 */

import { describe, expect, it } from "vitest";
import { calculateMtdSpend, validateMaxDurationHours } from "../../core/budget-guard.js";
import type { RunListItem } from "../../core/list.js";

describe("T5.4 Cost and Budget Guard", () => {
  describe("validateMaxDurationHours", () => {
    it("validates duration within 1-8 hours", () => {
      expect(validateMaxDurationHours(4)).toEqual({ valid: true, normalizedHours: 4 });
      expect(validateMaxDurationHours(8)).toEqual({ valid: true, normalizedHours: 8 });
    });

    it("clamps duration exceeding 8 hours to 8", () => {
      expect(validateMaxDurationHours(12)).toEqual({ valid: false, normalizedHours: 8 });
    });

    it("handles zero or negative duration", () => {
      expect(validateMaxDurationHours(0)).toEqual({ valid: false, normalizedHours: 4 });
    });
  });

  describe("calculateMtdSpend", () => {
    it("aggregates spend for runs created in the current calendar month", () => {
      const now = new Date();
      const thisMonthIso = new Date(now.getFullYear(), now.getMonth(), 5).toISOString();
      const lastYearIso = new Date(now.getFullYear() - 1, 0, 1).toISOString();

      const mockRuns: RunListItem[] = [
        {
          runId: "run-1",
          fullRunId: "run-1",
          status: "completed",
          statusBadge: "✓ completed",
          repo: "acme/api",
          workBranch: "main",
          model: "anthropic/claude-sonnet-4-5",
          turns: 5,
          tokens: "20k",
          tokensCount: 20000,
          cost: "$0.05 est.",
          costUsd: 0.05,
          elapsed: "10m",
          elapsedMs: 600000,
          lastEventAge: "1d ago",
          lastEventAgeSeconds: 86400,
          createdAt: thisMonthIso,
          updatedAt: thisMonthIso,
          activity: "Done",
          manifest: {
            v: 1,
            runId: "run-1",
            owner: "user",
            status: "completed",
            createdAt: thisMonthIso,
            updatedAt: thisMonthIso,
            imageVersion: "1.0",
            repo: { url: "https://github.com/acme/api", workBranch: "main" },
            model: { provider: "anthropic", id: "claude-sonnet-4-5" },
            timeline: [],
          },
        },
        {
          runId: "run-2",
          fullRunId: "run-2",
          status: "completed",
          statusBadge: "✓ completed",
          repo: "acme/api",
          workBranch: "main",
          model: "anthropic/claude-sonnet-4-5",
          turns: 10,
          tokens: "50k",
          tokensCount: 50000,
          cost: "$0.12 est.",
          costUsd: 0.12,
          elapsed: "20m",
          elapsedMs: 1200000,
          lastEventAge: "2d ago",
          lastEventAgeSeconds: 172800,
          createdAt: thisMonthIso,
          updatedAt: thisMonthIso,
          activity: "Done",
          manifest: {
            v: 1,
            runId: "run-2",
            owner: "user",
            status: "completed",
            createdAt: thisMonthIso,
            updatedAt: thisMonthIso,
            imageVersion: "1.0",
            repo: { url: "https://github.com/acme/api", workBranch: "main" },
            model: { provider: "anthropic", id: "claude-sonnet-4-5" },
            timeline: [],
          },
        },
        {
          runId: "run-old",
          fullRunId: "run-old",
          status: "completed",
          statusBadge: "✓ completed",
          repo: "acme/api",
          workBranch: "main",
          model: "anthropic/claude-sonnet-4-5",
          turns: 5,
          tokens: "20k",
          tokensCount: 20000,
          cost: "$0.50 est.",
          costUsd: 0.5,
          elapsed: "10m",
          elapsedMs: 600000,
          lastEventAge: "1y ago",
          lastEventAgeSeconds: 31536000,
          createdAt: lastYearIso,
          updatedAt: lastYearIso,
          activity: "Done",
          manifest: {
            v: 1,
            runId: "run-old",
            owner: "user",
            status: "completed",
            createdAt: lastYearIso,
            updatedAt: lastYearIso,
            imageVersion: "1.0",
            repo: { url: "https://github.com/acme/api", workBranch: "main" },
            model: { provider: "anthropic", id: "claude-sonnet-4-5" },
            timeline: [],
          },
        },
      ];

      const mtd = calculateMtdSpend(mockRuns);
      expect(mtd).toBeCloseTo(0.17, 2);
    });
  });
});
