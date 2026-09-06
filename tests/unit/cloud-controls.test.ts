/**
 * Unit tests for Cloud Agent Control Commands (T4.8).
 * Validates stop, suspend, resume, logs, PR creation, and interactive shell auth token minting.
 */

import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ResumeMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createCloudRunPullRequest,
  createCloudRunShellSession,
  fetchCloudRunLogs,
  resumeCloudRun,
  stopCloudRun,
  suspendCloudRun,
  tailCloudRunLogs,
} from "../../core/controls.js";
import {
  handleCloudLogsCommand,
  handleCloudPrCommand,
  handleCloudResumeCommand,
  handleCloudShellCommand,
  handleCloudStopCommand,
  handleCloudSuspendCommand,
} from "../../extension/commands/controls.js";
import type { RunManifest } from "../../shared/protocol.js";

const s3Mock = mockClient(S3Client);
const microvmsMock = mockClient(LambdaMicrovmsClient);
const cwLogsMock = mockClient(CloudWatchLogsClient);
const cfnMock = mockClient(CloudFormationClient);

interface MockSdkStream {
  transformToString: () => Promise<string>;
}

function mockS3Body(content: string): MockSdkStream {
  return {
    transformToString: async () => content,
  };
}

const activeManifest: RunManifest = {
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

describe("T4.8 Cloud Agent Controls", () => {
  beforeEach(() => {
    s3Mock.reset();
    microvmsMock.reset();
    cwLogsMock.reset();
    cfnMock.reset();

    cfnMock.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackName: "pi-cloud-agents",
          CreationTime: new Date(),
          StackStatus: "CREATE_COMPLETE",
          Outputs: [{ OutputKey: "BucketName", OutputValue: "test-bucket" }],
        },
        {
          StackName: "pi-cloud-agents-test",
          CreationTime: new Date(),
          StackStatus: "CREATE_COMPLETE",
          Outputs: [{ OutputKey: "BucketName", OutputValue: "test-bucket" }],
        },
      ],
    });
  });

  describe("stopCloudRun", () => {
    it("terminates MicroVM, updates manifest to terminated, and saves to S3", async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [{ Key: "runs/run-20260906-7f3a2c/manifest.json" }],
      });

      s3Mock
        .on(GetObjectCommand, {
          Bucket: "test-bucket",
          Key: "runs/run-20260906-7f3a2c/manifest.json",
        })
        .resolves({
          Body: mockS3Body(JSON.stringify(activeManifest)) as unknown as never,
        });

      let savedManifest: RunManifest | undefined;
      s3Mock.on(PutObjectCommand).callsFake((input) => {
        if (input.Body && typeof input.Body === "string") {
          savedManifest = JSON.parse(input.Body);
        }
        return {};
      });

      microvmsMock.on(TerminateMicrovmCommand).resolves({});

      const s3Client = new S3Client({ region: "us-east-1" });
      const microvmsClient = new LambdaMicrovmsClient({ region: "us-east-1" });

      const res = await stopCloudRun("7f3a2c", {
        bucket: "test-bucket",
        s3Client,
        microvmsClient,
        skipCheckpoint: true,
      });

      expect(res.status).toBe("terminated");
      expect(res.microvmId).toBe("mvm-0123456789abcdef0");
      expect(savedManifest?.status).toBe("terminated");
      expect(savedManifest?.timeline.some((t) => t.status === "terminated")).toBe(true);

      expect(microvmsMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(1);
    });
  });

  describe("suspendCloudRun and resumeCloudRun", () => {
    it("suspends active MicroVM and waits for SUSPENDED state", async () => {
      s3Mock
        .on(ListObjectsV2Command)
        .resolves({ Contents: [{ Key: "runs/run-20260906-7f3a2c/manifest.json" }] });

      s3Mock.on(GetObjectCommand).resolves({
        Body: mockS3Body(JSON.stringify(activeManifest)) as unknown as never,
      });

      s3Mock.on(PutObjectCommand).resolves({});

      microvmsMock.on(SuspendMicrovmCommand).resolves({});
      microvmsMock.on(GetMicrovmCommand).resolves({
        microvmId: "mvm-0123456789abcdef0",
        state: "SUSPENDED",
      });

      const s3Client = new S3Client({ region: "us-east-1" });
      const microvmsClient = new LambdaMicrovmsClient({ region: "us-east-1" });

      const res = await suspendCloudRun("7f3a2c", {
        bucket: "test-bucket",
        s3Client,
        microvmsClient,
        waitForState: true,
      });

      expect(res.status).toBe("suspended");
      expect(microvmsMock.commandCalls(SuspendMicrovmCommand)).toHaveLength(1);
    });

    it("resumes suspended MicroVM and waits for RUNNING state", async () => {
      const suspendedManifest: RunManifest = { ...activeManifest, status: "suspended" };

      s3Mock
        .on(ListObjectsV2Command)
        .resolves({ Contents: [{ Key: "runs/run-20260906-7f3a2c/manifest.json" }] });

      s3Mock.on(GetObjectCommand).resolves({
        Body: mockS3Body(JSON.stringify(suspendedManifest)) as unknown as never,
      });

      s3Mock.on(PutObjectCommand).resolves({});

      microvmsMock.on(ResumeMicrovmCommand).resolves({});
      microvmsMock.on(GetMicrovmCommand).resolves({
        microvmId: "mvm-0123456789abcdef0",
        state: "RUNNING",
      });

      const s3Client = new S3Client({ region: "us-east-1" });
      const microvmsClient = new LambdaMicrovmsClient({ region: "us-east-1" });

      const res = await resumeCloudRun("7f3a2c", {
        bucket: "test-bucket",
        s3Client,
        microvmsClient,
        waitForState: true,
      });

      expect(res.status).toBe("running");
      expect(microvmsMock.commandCalls(ResumeMicrovmCommand)).toHaveLength(1);
    });
  });

  describe("CloudWatch Logs (fetchCloudRunLogs & tailCloudRunLogs)", () => {
    it("queries CloudWatch logs filtered by runId", async () => {
      s3Mock
        .on(ListObjectsV2Command)
        .resolves({ Contents: [{ Key: "runs/run-20260906-7f3a2c/manifest.json" }] });

      cwLogsMock.on(FilterLogEventsCommand).resolves({
        events: [
          {
            timestamp: 1788736977000,
            message: "Runner starting on port 8080",
            logStreamName: "stream-01",
            eventId: "evt-01",
          },
          {
            timestamp: 1788736980000,
            message: "pi process initialized with 2 tools",
            logStreamName: "stream-01",
            eventId: "evt-02",
          },
        ],
      });

      const s3Client = new S3Client({ region: "us-east-1" });
      const cwLogsClient = new CloudWatchLogsClient({ region: "us-east-1" });

      const result = await fetchCloudRunLogs("7f3a2c", {
        bucket: "test-bucket",
        s3Client,
        cwLogsClient,
      });

      expect(result.events).toHaveLength(2);
      expect(result.events[0]?.message).toBe("Runner starting on port 8080");
      expect(result.events[1]?.message).toBe("pi process initialized with 2 tools");
      expect(cwLogsMock.commandCalls(FilterLogEventsCommand)).toHaveLength(1);
    });

    it("tails logs via tailCloudRunLogs and cancels cleanly", async () => {
      cwLogsMock.on(FilterLogEventsCommand).resolves({
        events: [
          {
            timestamp: Date.now(),
            message: "Live telemetry tick",
            eventId: "evt-tick-01",
          },
        ],
      });

      const cwLogsClient = new CloudWatchLogsClient({ region: "us-east-1" });
      const received: string[] = [];

      const cancel = tailCloudRunLogs(
        "run-7f3a2c",
        (evt) => {
          received.push(evt.message);
        },
        {
          cwLogsClient,
          pollIntervalMs: 50,
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 150));
      cancel();

      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(received[0]).toBe("Live telemetry tick");
    });
  });

  describe("createCloudRunPullRequest", () => {
    it("returns existing PR URL if already created in manifest", async () => {
      const manifestWithPr: RunManifest = {
        ...activeManifest,
        git: {
          workBranch: "pi-cloud/7f3a2c",
          prUrl: "https://github.com/acme/api/pull/42",
        },
      };

      s3Mock
        .on(ListObjectsV2Command)
        .resolves({ Contents: [{ Key: "runs/run-20260906-7f3a2c/manifest.json" }] });

      s3Mock.on(GetObjectCommand).resolves({
        Body: mockS3Body(JSON.stringify(manifestWithPr)) as unknown as never,
      });

      const s3Client = new S3Client({ region: "us-east-1" });

      const res = await createCloudRunPullRequest("7f3a2c", {
        bucket: "test-bucket",
        s3Client,
      });

      expect(res.prUrl).toBe("https://github.com/acme/api/pull/42");
      expect(res.message).toContain("https://github.com/acme/api/pull/42");
    });

    it("generates manual publish and PR commands if runner prUrl is not available", async () => {
      s3Mock
        .on(ListObjectsV2Command)
        .resolves({ Contents: [{ Key: "runs/run-20260906-7f3a2c/manifest.json" }] });

      s3Mock.on(GetObjectCommand).resolves({
        Body: mockS3Body(JSON.stringify(activeManifest)) as unknown as never,
      });

      const s3Client = new S3Client({ region: "us-east-1" });

      const res = await createCloudRunPullRequest("7f3a2c", {
        bucket: "test-bucket",
        s3Client,
        title: "Add OAuth feature",
      });

      expect(res.workBranch).toBe("pi-cloud/7f3a2c");
      expect(res.manualCommands).toBeDefined();
      expect(res.manualCommands?.some((c) => c.includes("gh pr create"))).toBe(true);
    });
  });

  describe("createCloudRunShellSession", () => {
    it("mints 15-minute token scoped to port 8022 and returns WebSocket connection info", async () => {
      s3Mock
        .on(ListObjectsV2Command)
        .resolves({ Contents: [{ Key: "runs/run-20260906-7f3a2c/manifest.json" }] });

      s3Mock.on(GetObjectCommand).resolves({
        Body: mockS3Body(JSON.stringify(activeManifest)) as unknown as never,
      });

      microvmsMock.on(CreateMicrovmAuthTokenCommand).resolves({
        authToken: {
          "X-aws-proxy-auth": "mock-jwe-shell-token-secret-12345",
        },
      });

      const s3Client = new S3Client({ region: "us-east-1" });
      const microvmsClient = new LambdaMicrovmsClient({ region: "us-east-1" });

      const session = await createCloudRunShellSession("7f3a2c", {
        bucket: "test-bucket",
        s3Client,
        microvmsClient,
      });

      expect(session.microvmId).toBe("mvm-0123456789abcdef0");
      expect(session.port).toBe(8022);
      expect(session.wsUrl).toBe(
        "wss://mvm-0123456789abcdef0.microvm.us-east-1.amazonaws.com/shell",
      );
      expect(session.subprotocols).toContain("lambda-microvms");
      expect(session.subprotocols).toContain("lambda-microvms.port.8022");
      expect(session.subprotocols).toContain(
        "lambda-microvms.authentication.mock-jwe-shell-token-secret-12345",
      );

      const calls = microvmsMock.commandCalls(CreateMicrovmAuthTokenCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args[0].input.allowedPorts).toEqual([{ port: 8022 }]);
      expect(calls[0]?.args[0].input.expirationInMinutes).toBe(15);
    });
  });

  describe("Extension command handlers", () => {
    it("handles /cloud stop with prompt and execution", async () => {
      s3Mock
        .on(ListObjectsV2Command)
        .resolves({ Contents: [{ Key: "runs/run-20260906-7f3a2c/manifest.json" }] });

      s3Mock.on(GetObjectCommand).resolves({
        Body: mockS3Body(JSON.stringify(activeManifest)) as unknown as never,
      });

      s3Mock.on(PutObjectCommand).resolves({});
      microvmsMock.on(TerminateMicrovmCommand).resolves({});

      const res = await handleCloudStopCommand(["7f3a2c", "--yes"], { hasUI: false });
      expect(res.handled).toBe(true);
      expect(res.output).toContain("terminated successfully");
    });

    it("handles /cloud suspend and /cloud resume", async () => {
      s3Mock
        .on(ListObjectsV2Command)
        .resolves({ Contents: [{ Key: "runs/run-20260906-7f3a2c/manifest.json" }] });

      s3Mock.on(GetObjectCommand).resolves({
        Body: mockS3Body(JSON.stringify(activeManifest)) as unknown as never,
      });

      s3Mock.on(PutObjectCommand).resolves({});
      microvmsMock.on(SuspendMicrovmCommand).resolves({});
      microvmsMock.on(GetMicrovmCommand).resolves({ state: "SUSPENDED" });

      const suspendRes = await handleCloudSuspendCommand(["7f3a2c"], { hasUI: false });
      expect(suspendRes.handled).toBe(true);
      expect(suspendRes.output).toContain("suspended successfully");

      microvmsMock.on(ResumeMicrovmCommand).resolves({});
      microvmsMock.on(GetMicrovmCommand).resolves({ state: "RUNNING" });

      const resumeRes = await handleCloudResumeCommand(["7f3a2c"], { hasUI: false });
      expect(resumeRes.handled).toBe(true);
      expect(resumeRes.output).toContain("resumed successfully");
    });

    it("handles /cloud logs and /cloud pr", async () => {
      s3Mock
        .on(ListObjectsV2Command)
        .resolves({ Contents: [{ Key: "runs/run-20260906-7f3a2c/manifest.json" }] });

      s3Mock.on(GetObjectCommand).resolves({
        Body: mockS3Body(JSON.stringify(activeManifest)) as unknown as never,
      });

      cwLogsMock.on(FilterLogEventsCommand).resolves({ events: [] });

      const logsRes = await handleCloudLogsCommand(["7f3a2c"], { hasUI: false });
      expect(logsRes.handled).toBe(true);
      expect(logsRes.output).toContain("CloudWatch logs for run 'run-20260906-7f3a2c'");

      const prRes = await handleCloudPrCommand(["7f3a2c", "My PR Title"], { hasUI: false });
      expect(prRes.handled).toBe(true);
      expect(prRes.output).toContain("Work branch: pi-cloud/7f3a2c");
    });

    it("handles /cloud shell", async () => {
      s3Mock
        .on(ListObjectsV2Command)
        .resolves({ Contents: [{ Key: "runs/run-20260906-7f3a2c/manifest.json" }] });

      s3Mock.on(GetObjectCommand).resolves({
        Body: mockS3Body(JSON.stringify(activeManifest)) as unknown as never,
      });

      microvmsMock.on(CreateMicrovmAuthTokenCommand).resolves({
        authToken: { "X-aws-proxy-auth": "secret-shell-token" },
      });

      const shellRes = await handleCloudShellCommand(["7f3a2c"], { hasUI: false });
      expect(shellRes.handled).toBe(true);
      expect(shellRes.output).toContain("Interactive shell session ready");
      expect(shellRes.output).toContain("port 8022");
    });
  });
});
