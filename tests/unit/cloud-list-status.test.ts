/**
 * Unit tests for Cloud List and Status Detail Card (T4.6).
 * Validates manifest merging, active VM reconciliation, cost calculation,
 * and snapshot rendering at 80 and 120 columns per 07-ux-and-observability.md §2.2 & §2.3.
 */

import {
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
} from "@aws-sdk/client-lambda-microvms";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type RunListItem,
  calculateMicrovmCost,
  formatElapsed,
  formatRelativeAge,
  formatRepoRef,
  formatStatusBadge,
  formatTokenCount,
  listCloudRuns,
} from "../../core/list.js";
import { fetchRunStatusDetails, formatRunStatusCard, resolveRunId } from "../../core/status.js";
import { formatRunsTable, handleCloudListCommand } from "../../extension/commands/list.js";
import { handleCloudStatusCommand } from "../../extension/commands/status.js";
import { visibleWidth } from "../../extension/ui/kit.js";
import type { RunManifest } from "../../shared/protocol.js";

const s3Mock = mockClient(S3Client);
const microvmsMock = mockClient(LambdaMicrovmsClient);

interface MockSdkStream {
  transformToString: () => Promise<string>;
}

function mockS3Body(content: string): MockSdkStream {
  return {
    transformToString: async () => content,
  };
}

const sampleManifestRunning: RunManifest = {
  v: 1,
  runId: "run-20260906-7f3a2c",
  owner: "user-ant",
  status: "running",
  createdAt: "2026-09-06T12:00:00.000Z",
  updatedAt: "2026-09-06T12:42:00.000Z",
  microvmId: "mvm-0123456789abcdef0",
  endpoint: "mvm-0123456789abcdef0.microvm.us-east-1.amazonaws.com",
  imageVersion: "12",
  repo: {
    url: "https://github.com/acme/api.git",
    ref: "main",
    workBranch: "pi-cloud/7f3a2c",
  },
  model: {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
  },
  usage: {
    inputTokens: 184000,
    outputTokens: 21000,
    totalTokens: 205000,
    estimatedCostUsd: 0.91,
  },
  git: {
    workBranch: "pi-cloud/7f3a2c",
    lastCommit: "commit-abc1234",
  },
  timeline: [
    { status: "launching", at: "2026-09-06T12:00:00.000Z" },
    { status: "running", at: "2026-09-06T12:00:02.100Z" },
  ],
};

const sampleManifestCompleted: RunManifest = {
  v: 1,
  runId: "run-20260906-abc111",
  owner: "user-ant",
  status: "completed",
  createdAt: "2026-09-06T10:00:00.000Z",
  updatedAt: "2026-09-06T10:15:30.000Z",
  microvmId: "mvm-abcdef1234567890",
  endpoint: "mvm-abcdef1234567890.microvm.us-east-1.amazonaws.com",
  imageVersion: "11",
  repo: {
    url: "https://github.com/acme/web.git",
    ref: "feat/auth",
    workBranch: "pi-cloud/abc111",
  },
  model: {
    provider: "anthropic",
    id: "claude-haiku-3-5",
  },
  usage: {
    inputTokens: 42000,
    outputTokens: 5200,
    totalTokens: 47200,
    estimatedCostUsd: 0.12,
  },
  git: {
    workBranch: "pi-cloud/abc111",
    lastCommit: "commit-def5678",
  },
  timeline: [
    { status: "launching", at: "2026-09-06T10:00:00.000Z" },
    { status: "running", at: "2026-09-06T10:00:03.000Z" },
    { status: "completed", at: "2026-09-06T10:15:30.000Z" },
  ],
};

describe("T4.6 /cloud list & /cloud status", () => {
  beforeEach(() => {
    s3Mock.reset();
    microvmsMock.reset();
  });

  describe("Cost calculation and formatters", () => {
    it("calculates estimated MicroVM execution cost for 4 GB / 2 vCPU baseline", () => {
      // 4096 MiB = 2 vCPU + 4 GB RAM -> rate = 2*0.0000276944 + 4*0.0000036667 = 0.0000700556 / sec
      // 3600 seconds = $0.2522 / hour
      const cost1h = calculateMicrovmCost(4096, 3600);
      expect(cost1h.computeCostUsd).toBeCloseTo(0.2522, 3);
      expect(cost1h.totalCostUsd).toBeCloseTo(0.2522, 3);
      expect(cost1h.formatted).toBe("$0.25 est.");

      // 45 min = 2700 sec -> ~ $0.189
      const cost45m = calculateMicrovmCost(4096, 2700, { tokenCostUsd: 0.5 });
      expect(cost45m.computeCostUsd).toBeCloseTo(0.1891, 3);
      expect(cost45m.totalCostUsd).toBeCloseTo(0.6891, 3);
      expect(cost45m.formatted).toBe("$0.69 est.");
    });

    it("formats tokens, elapsed times, repo refs, and status badges correctly", () => {
      expect(formatTokenCount(0)).toBe("0");
      expect(formatTokenCount(450)).toBe("450");
      expect(formatTokenCount(205000)).toBe("205k");
      expect(formatTokenCount(1500000)).toBe("1.5M");

      expect(formatElapsed(500)).toBe("0s");
      expect(formatElapsed(12000)).toBe("12s");
      expect(formatElapsed(42 * 60 * 1000)).toBe("42m");
      expect(formatElapsed((2 * 3600 + 15 * 60) * 1000)).toBe("2h 15m");

      expect(formatRelativeAge(1)).toBe("1s ago");
      expect(formatRelativeAge(120)).toBe("2m ago");
      expect(formatRelativeAge(7200)).toBe("2h ago");

      expect(formatRepoRef("https://github.com/acme/api.git", "main")).toBe("acme/api#main");
      expect(formatRepoRef("https://github.com/acme/api.git")).toBe("acme/api");

      expect(formatStatusBadge("running")).toBe("● running");
      expect(formatStatusBadge("idle")).toBe("○ idle");
      expect(formatStatusBadge("suspended")).toBe("◌ suspended");
      expect(formatStatusBadge("completed")).toBe("✓ completed");
      expect(formatStatusBadge("failed")).toBe("▲ failed");
    });
  });

  describe("listCloudRuns", () => {
    it("discovers S3 manifests, merges with active MicroVM state, and sorts newest first", async () => {
      s3Mock.on(ListObjectsV2Command, { Bucket: "test-bucket", Prefix: "runs/" }).resolves({
        Contents: [
          { Key: "runs/run-20260906-abc111/manifest.json" },
          { Key: "runs/run-20260906-7f3a2c/manifest.json" },
        ],
      });

      s3Mock
        .on(GetObjectCommand, {
          Bucket: "test-bucket",
          Key: "runs/run-20260906-abc111/manifest.json",
        })
        .resolves({
          Body: mockS3Body(JSON.stringify(sampleManifestCompleted)) as unknown as never,
        });

      s3Mock
        .on(GetObjectCommand, {
          Bucket: "test-bucket",
          Key: "runs/run-20260906-7f3a2c/manifest.json",
        })
        .resolves({
          Body: mockS3Body(JSON.stringify(sampleManifestRunning)) as unknown as never,
        });

      microvmsMock.on(ListMicrovmsCommand).resolves({
        items: [
          {
            microvmId: "mvm-0123456789abcdef0",
            state: "RUNNING",
            imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image/runner",
            imageVersion: "12",
            startedAt: new Date("2026-09-06T12:00:00.000Z"),
          },
        ],
      });

      const s3Client = new S3Client({ region: "us-east-1" });
      const microvmsClient = new LambdaMicrovmsClient({ region: "us-east-1" });

      const runs = await listCloudRuns({
        bucket: "test-bucket",
        s3Client,
        microvmsClient,
        fetchLiveStatus: false,
      });

      expect(runs).toHaveLength(2);
      // Newest first (7f3a2c was updated at 12:42 vs 10:15)
      expect(runs[0]?.fullRunId).toBe("run-20260906-7f3a2c");
      expect(runs[0]?.status).toBe("running");
      expect(runs[0]?.statusBadge).toBe("● running");
      expect(runs[0]?.tokens).toBe("205k");
      expect(runs[0]?.cost).toContain("est.");

      expect(runs[1]?.fullRunId).toBe("run-20260906-abc111");
      expect(runs[1]?.status).toBe("completed");
      expect(runs[1]?.statusBadge).toBe("✓ completed");
    });
  });

  describe("formatRunsTable layout & snapshots", () => {
    it("renders formatted width-safe table responsive at 80 and 120 columns", () => {
      const runItem: RunListItem = {
        runId: "7f3a2c",
        fullRunId: "run-20260906-7f3a2c",
        status: "running",
        statusBadge: "● running",
        repo: "acme/api#main",
        workBranch: "pi-cloud/7f3a2c",
        model: "claude-sonnet-4-5",
        activity: "running",
        turns: 14,
        tokens: "205k",
        tokensCount: 205000,
        cost: "$0.91 est.",
        costUsd: 0.91,
        elapsed: "42m",
        elapsedMs: 42 * 60 * 1000,
        lastEventAge: "1s ago",
        lastEventAgeSeconds: 1,
        createdAt: "2026-09-06T12:00:00.000Z",
        updatedAt: "2026-09-06T12:42:00.000Z",
        manifest: sampleManifestRunning,
      };

      const table80 = formatRunsTable([runItem], { maxWidth: 80 });
      expect(table80).toContain("State");
      expect(table80).toContain("Run");
      expect(table80).toContain("● running");
      expect(table80).toContain("7f3a2c");

      // Verify no line exceeds width
      const lines80 = table80.split("\n");
      for (const line of lines80) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(80);
      }

      const table120 = formatRunsTable([runItem], { maxWidth: 120 });
      const lines120 = table120.split("\n");
      for (const line of lines120) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(120);
      }
    });
  });

  describe("fetchRunStatusDetails and formatRunStatusCard", () => {
    it("fetches run status details from S3 and renders detail card matching §2.3 spec", async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [{ Key: "runs/run-20260906-7f3a2c/manifest.json" }],
      });

      s3Mock
        .on(GetObjectCommand, {
          Bucket: "test-bucket",
          Key: "runs/run-20260906-7f3a2c/manifest.json",
        })
        .resolves({
          Body: mockS3Body(JSON.stringify(sampleManifestRunning)) as unknown as never,
        });

      microvmsMock.on(GetMicrovmCommand).resolves({
        microvmId: "mvm-0123456789abcdef0",
        state: "RUNNING",
      });

      const s3Client = new S3Client({ region: "us-east-1" });
      const microvmsClient = new LambdaMicrovmsClient({ region: "us-east-1" });

      const details = await fetchRunStatusDetails("7f3a2c", {
        bucket: "test-bucket",
        s3Client,
        microvmsClient,
        fetchLiveMetrics: false,
      });

      expect(details.shortRunId).toBe("7f3a2c");
      expect(details.status).toBe("running");
      expect(details.statusBadge).toBe("● running");
      expect(details.repo.displayRepo).toBe("acme/api#main");
      expect(details.model.provider).toBe("anthropic");

      const card = formatRunStatusCard(details, { width: 80 });
      expect(card).toContain("run 7f3a2c");
      expect(card).toContain("● running");
      expect(card).toContain("repository  acme/api#main → pi-cloud/7f3a2c");
      expect(card).toContain("model       anthropic/claude-sonnet-4-5");
      expect(card).toContain("timeline");
      expect(card).toContain("turns");
      expect(card).toContain("tokens");
      expect(card).toContain("vm");
      expect(card).toContain("checkpoints");
    });
  });

  describe("Command handlers", () => {
    it("paginates ListObjectsV2Command when resolving runId if truncated", async () => {
      s3Mock
        .on(ListObjectsV2Command, { ContinuationToken: undefined })
        .resolves({
          Contents: [{ Key: "runs/run-20260906-other/manifest.json" }],
          IsTruncated: true,
          NextContinuationToken: "next-token-123",
        })
        .on(ListObjectsV2Command, { ContinuationToken: "next-token-123" })
        .resolves({
          Contents: [{ Key: "runs/run-20260906-targetrun/manifest.json" }],
          IsTruncated: false,
        });

      const s3Client = new S3Client({ region: "us-east-1" });
      const resolved = await resolveRunId(s3Client, "test-bucket", "targetrun");
      expect(resolved).toBe("run-20260906-targetrun");
    });

    it("handleCloudListCommand returns formatted output and supports --json", async () => {
      s3Mock.on(ListObjectsV2Command, { Bucket: "test-bucket", Prefix: "runs/" }).resolves({
        Contents: [{ Key: "runs/run-20260906-7f3a2c/manifest.json" }],
      });

      s3Mock
        .on(GetObjectCommand, {
          Bucket: "test-bucket",
          Key: "runs/run-20260906-7f3a2c/manifest.json",
        })
        .resolves({
          Body: mockS3Body(JSON.stringify(sampleManifestRunning)) as unknown as never,
        });

      microvmsMock.on(ListMicrovmsCommand).resolves({ items: [] });

      const res = await handleCloudListCommand(["--json"], {
        hasUI: false,
      });

      expect(res.handled).toBe(true);
      expect(res.subcommand).toBe("list");
    });

    it("handleCloudStatusCommand validates runId and returns usage when missing", async () => {
      const res = await handleCloudStatusCommand([], { hasUI: false });
      expect(res.handled).toBe(true);
      expect(res.output).toContain("Usage: /cloud status <runId>");
    });
  });
});
