import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DeleteSecretCommand,
  ListSecretsCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { executeControllerRun, handler } from "../../infra/controller/handler.js";

const microvmsMock = mockClient(LambdaMicrovmsClient);
const s3Mock = mockClient(S3Client);
const secretsMock = mockClient(SecretsManagerClient);

interface MockSdkStream {
  transformToString: () => Promise<string>;
}

function mockS3Body(content: string) {
  return {
    transformToString: async () => content,
  } as unknown as MockSdkStream;
}

describe("T3.5 Controller Lambda", () => {
  beforeEach(() => {
    microvmsMock.reset();
    s3Mock.reset();
    secretsMock.reset();
  });

  it("keeps active agent alive via HTTP GET /v1/status ping and never suspends", async () => {
    const fixedNow = new Date("2026-09-06T12:00:00Z").getTime();

    microvmsMock.on(ListMicrovmsCommand).resolves({
      items: [
        {
          microvmId: "vm-active-01",
          state: "RUNNING",
          imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner",
          imageVersion: "1.0",
          startedAt: new Date(fixedNow - 300_000), // 5 min ago
        },
      ],
    });

    microvmsMock.on(GetMicrovmCommand, { microvmIdentifier: "vm-active-01" }).resolves({
      microvmId: "vm-active-01",
      state: "RUNNING",
      endpoint: "vm-active-01.microvm.us-east-1.amazonaws.com",
      startedAt: new Date(fixedNow - 300_000),
    });

    s3Mock.on(GetObjectCommand, { Bucket: "test-bucket", Key: "index/vm-active-01" }).resolves({
      Body: mockS3Body(JSON.stringify({ runId: "run-active-01" })) as unknown as never,
    });

    s3Mock
      .on(GetObjectCommand, { Bucket: "test-bucket", Key: "runs/run-active-01/manifest.json" })
      .resolves({
        Body: mockS3Body(
          JSON.stringify({
            runId: "run-active-01",
            status: "running",
            updatedAt: new Date(fixedNow - 60_000).toISOString(),
            options: { maxDurationSec: 28800 },
          }),
        ) as unknown as never,
      });

    microvmsMock.on(CreateMicrovmAuthTokenCommand).resolves({
      authToken: { "X-aws-proxy-auth": "token-test-proxy-auth" },
    });

    s3Mock.on(DeleteObjectCommand).resolves({});
    s3Mock.on(PutObjectCommand).resolves({});

    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      return new Response(
        JSON.stringify({
          status: "running",
          runId: "run-active-01",
          uptimeSeconds: 300,
          agentState: "streaming",
          suggestedAction: "none",
          policy: { idleGraceSec: 120 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const summary = await executeControllerRun({
      stackName: "test-stack",
      bucketName: "test-bucket",
      imageName: "pi-cloud-agents-runner",
      region: "us-east-1",
      clock: () => fixedNow,
      fetchFn: mockFetch as typeof fetch,
    });

    expect(capturedUrl).toBe("https://vm-active-01.microvm.us-east-1.amazonaws.com/v1/status");
    expect(capturedHeaders["X-aws-proxy-auth"]).toBe("token-test-proxy-auth");
    expect(capturedHeaders["X-aws-proxy-port"]).toBe("8080");

    expect(summary.runningCount).toBe(1);
    expect(summary.decisions[0]?.action).toBe("keepalive");
    expect(summary.decisions[0]?.reason).toContain("Keepalive ping successful");
    expect(microvmsMock.commandCalls(SuspendMicrovmCommand).length).toBe(0);
    expect(microvmsMock.commandCalls(TerminateMicrovmCommand).length).toBe(0);
  });

  it("suspends idle agent when suggestedAction is suspend and idle threshold is exceeded", async () => {
    const fixedNow = new Date("2026-09-06T12:00:00Z").getTime();

    microvmsMock.on(ListMicrovmsCommand).resolves({
      items: [
        {
          microvmId: "vm-idle-01",
          state: "RUNNING",
          imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner",
          imageVersion: "1.0",
          startedAt: new Date(fixedNow - 600_000), // 10 min ago
        },
      ],
    });

    microvmsMock.on(GetMicrovmCommand, { microvmIdentifier: "vm-idle-01" }).resolves({
      microvmId: "vm-idle-01",
      state: "RUNNING",
      endpoint: "vm-idle-01.microvm.us-east-1.amazonaws.com",
      startedAt: new Date(fixedNow - 600_000),
    });

    s3Mock.on(GetObjectCommand, { Bucket: "test-bucket", Key: "index/vm-idle-01" }).resolves({
      Body: mockS3Body(JSON.stringify({ runId: "run-idle-01" })) as unknown as never,
    });

    s3Mock
      .on(GetObjectCommand, { Bucket: "test-bucket", Key: "runs/run-idle-01/manifest.json" })
      .resolves({
        Body: mockS3Body(
          JSON.stringify({
            runId: "run-idle-01",
            status: "idle",
            updatedAt: new Date(fixedNow - 200_000).toISOString(),
            options: { maxDurationSec: 28800 },
          }),
        ) as unknown as never,
      });

    microvmsMock.on(CreateMicrovmAuthTokenCommand).resolves({
      authToken: { "X-aws-proxy-auth": "token-test-proxy-auth" },
    });

    microvmsMock.on(SuspendMicrovmCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});
    s3Mock.on(PutObjectCommand).resolves({});

    const mockFetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          status: "idle",
          runId: "run-idle-01",
          uptimeSeconds: 600,
          agentState: "idle",
          idleSince: new Date(fixedNow - 180_000).toISOString(), // idle for 180s (grace: 120s)
          suggestedAction: "suspend",
          policy: { idleGraceSec: 120 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const summary = await executeControllerRun({
      stackName: "test-stack",
      bucketName: "test-bucket",
      imageName: "pi-cloud-agents-runner",
      region: "us-east-1",
      clock: () => fixedNow,
      fetchFn: mockFetch as typeof fetch,
    });

    expect(summary.runningCount).toBe(1);
    expect(summary.decisions[0]?.action).toBe("suspend");
    expect(summary.decisions[0]?.reason).toContain("Agent idle for");
    expect(microvmsMock.commandCalls(SuspendMicrovmCommand).length).toBe(1);
    expect(microvmsMock.commandCalls(SuspendMicrovmCommand)[0]?.args[0].input).toEqual({
      microvmIdentifier: "vm-idle-01",
    });
  });

  it("does not suspend idle agent within idle grace period", async () => {
    const fixedNow = new Date("2026-09-06T12:00:00Z").getTime();

    microvmsMock.on(ListMicrovmsCommand).resolves({
      items: [
        {
          microvmId: "vm-idle-young",
          state: "RUNNING",
          imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner",
          imageVersion: "1.0",
          startedAt: new Date(fixedNow - 300_000),
        },
      ],
    });

    microvmsMock.on(GetMicrovmCommand).resolves({
      microvmId: "vm-idle-young",
      state: "RUNNING",
      endpoint: "vm-idle-young.microvm.us-east-1.amazonaws.com",
      startedAt: new Date(fixedNow - 300_000),
    });

    s3Mock.on(GetObjectCommand).resolves({
      Body: mockS3Body(
        JSON.stringify({ runId: "run-idle-young", status: "idle" }),
      ) as unknown as never,
    });

    microvmsMock.on(CreateMicrovmAuthTokenCommand).resolves({
      authToken: { "X-aws-proxy-auth": "token-test" },
    });

    const mockFetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          status: "idle",
          runId: "run-idle-young",
          uptimeSeconds: 300,
          agentState: "idle",
          idleSince: new Date(fixedNow - 45_000).toISOString(), // only 45s idle (< 120s grace)
          suggestedAction: "suspend",
          policy: { idleGraceSec: 120 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const summary = await executeControllerRun({
      stackName: "test-stack",
      bucketName: "test-bucket",
      clock: () => fixedNow,
      fetchFn: mockFetch as typeof fetch,
    });

    expect(summary.decisions[0]?.action).toBe("keepalive");
    expect(microvmsMock.commandCalls(SuspendMicrovmCommand).length).toBe(0);
  });

  it("janitor force-deletes run-scoped secrets for TERMINATED runs", async () => {
    microvmsMock.on(ListMicrovmsCommand).resolves({
      items: [
        {
          microvmId: "vm-term-01",
          state: "TERMINATED",
          imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner",
          imageVersion: "1.0",
          startedAt: new Date(),
        },
      ],
    });

    s3Mock.on(GetObjectCommand, { Bucket: "test-bucket", Key: "index/vm-term-01" }).resolves({
      Body: mockS3Body(JSON.stringify({ runId: "run-term-01" })) as unknown as never,
    });

    secretsMock.on(ListSecretsCommand).resolves({
      SecretList: [
        { Name: "pi-cloud-agents/test-stack/runs/run-term-01/github-token" },
        { Name: "pi-cloud-agents/test-stack/runs/run-term-01/custom-secret" },
      ],
    });

    secretsMock.on(DeleteSecretCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});

    const summary = await executeControllerRun({
      stackName: "test-stack",
      bucketName: "test-bucket",
    });

    expect(summary.terminatedCount).toBe(1);
    expect(summary.decisions[0]?.action).toBe("janitor_secret_cleanup");
    expect(summary.decisions[0]?.reason).toContain("Force-deleted 2 run-scoped secret(s)");
    expect(secretsMock.commandCalls(DeleteSecretCommand).length).toBe(2);
    expect(secretsMock.commandCalls(DeleteSecretCommand)[0]?.args[0].input).toEqual({
      SecretId: "pi-cloud-agents/test-stack/runs/run-term-01/github-token",
      ForceDeleteWithoutRecovery: true,
    });
  });

  it("terminates runs that have been in completed/failed state for > 10 minutes", async () => {
    const fixedNow = new Date("2026-09-06T12:00:00Z").getTime();

    microvmsMock.on(ListMicrovmsCommand).resolves({
      items: [
        {
          microvmId: "vm-finished-01",
          state: "RUNNING",
          imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner",
          imageVersion: "1.0",
          startedAt: new Date(fixedNow - 1200_000),
        },
      ],
    });

    microvmsMock.on(GetMicrovmCommand).resolves({
      microvmId: "vm-finished-01",
      state: "RUNNING",
      endpoint: "vm-finished.endpoint",
      startedAt: new Date(fixedNow - 1200_000),
    });

    s3Mock.on(GetObjectCommand, { Bucket: "test-bucket", Key: "index/vm-finished-01" }).resolves({
      Body: mockS3Body(JSON.stringify({ runId: "run-finished-01" })) as unknown as never,
    });

    s3Mock
      .on(GetObjectCommand, { Bucket: "test-bucket", Key: "runs/run-finished-01/manifest.json" })
      .resolves({
        Body: mockS3Body(
          JSON.stringify({
            runId: "run-finished-01",
            status: "completed",
            updatedAt: new Date(fixedNow - 700_000).toISOString(), // finished 700s ago (> 600s grace)
          }),
        ) as unknown as never,
      });

    microvmsMock.on(TerminateMicrovmCommand).resolves({});

    const summary = await executeControllerRun({
      stackName: "test-stack",
      bucketName: "test-bucket",
      clock: () => fixedNow,
    });

    expect(summary.decisions[0]?.action).toBe("terminate");
    expect(summary.decisions[0]?.reason).toContain("is in finished state 'completed' for");
    expect(microvmsMock.commandCalls(TerminateMicrovmCommand).length).toBe(1);
    expect(microvmsMock.commandCalls(TerminateMicrovmCommand)[0]?.args[0].input).toEqual({
      microvmIdentifier: "vm-finished-01",
    });
  });

  it("terminates orphaned MicroVMs with no manifest after 20 minutes", async () => {
    const fixedNow = new Date("2026-09-06T12:00:00Z").getTime();

    microvmsMock.on(ListMicrovmsCommand).resolves({
      items: [
        {
          microvmId: "vm-orphan-01",
          state: "RUNNING",
          imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner",
          imageVersion: "1.0",
          startedAt: new Date(fixedNow - 1300_000), // running for 1300s (> 1200s orphan grace)
        },
      ],
    });

    microvmsMock.on(GetMicrovmCommand).resolves({
      microvmId: "vm-orphan-01",
      state: "RUNNING",
      endpoint: "vm-orphan.endpoint",
      startedAt: new Date(fixedNow - 1300_000),
    });

    s3Mock.on(GetObjectCommand).rejects(new Error("NoSuchKey"));
    microvmsMock.on(TerminateMicrovmCommand).resolves({});

    const summary = await executeControllerRun({
      stackName: "test-stack",
      bucketName: "test-bucket",
      clock: () => fixedNow,
    });

    expect(summary.decisions[0]?.action).toBe("terminate");
    expect(summary.decisions[0]?.reason).toContain("Orphaned MicroVM running without manifest");
    expect(microvmsMock.commandCalls(TerminateMicrovmCommand).length).toBe(1);
  });

  it("tracks unhealthy polls and terminates after 3+ failures and > 15 minutes", async () => {
    const fixedNow = new Date("2026-09-06T12:00:00Z").getTime();

    microvmsMock.on(ListMicrovmsCommand).resolves({
      items: [
        {
          microvmId: "vm-unhealthy-01",
          state: "RUNNING",
          imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner",
          imageVersion: "1.0",
          startedAt: new Date(fixedNow - 1200_000),
        },
      ],
    });

    microvmsMock.on(GetMicrovmCommand).resolves({
      microvmId: "vm-unhealthy-01",
      state: "RUNNING",
      endpoint: "vm-unhealthy.endpoint",
      startedAt: new Date(fixedNow - 1200_000),
    });

    s3Mock.on(GetObjectCommand, { Bucket: "test-bucket", Key: "index/vm-unhealthy-01" }).resolves({
      Body: mockS3Body(JSON.stringify({ runId: "run-unhealthy-01" })) as unknown as never,
    });

    s3Mock
      .on(GetObjectCommand, { Bucket: "test-bucket", Key: "runs/run-unhealthy-01/manifest.json" })
      .resolves({
        Body: mockS3Body(
          JSON.stringify({
            runId: "run-unhealthy-01",
            status: "running",
          }),
        ) as unknown as never,
      });

    // Previous health state: already 3 failures starting 1000s ago (> 900s limit)
    s3Mock
      .on(GetObjectCommand, {
        Bucket: "test-bucket",
        Key: "controller/health/vm-unhealthy-01.json",
      })
      .resolves({
        Body: mockS3Body(
          JSON.stringify({
            consecutiveFailures: 3,
            firstFailedAt: new Date(fixedNow - 1000_000).toISOString(),
            lastFailedAt: new Date(fixedNow - 60_000).toISOString(),
          }),
        ) as unknown as never,
      });

    microvmsMock.on(CreateMicrovmAuthTokenCommand).resolves({
      authToken: { "X-aws-proxy-auth": "token-test" },
    });

    microvmsMock.on(TerminateMicrovmCommand).resolves({});
    s3Mock.on(PutObjectCommand).resolves({});

    // Network request throws error
    const mockFailingFetch = async (): Promise<Response> => {
      throw new Error("Connection refused 502 Bad Gateway");
    };

    const summary = await executeControllerRun({
      stackName: "test-stack",
      bucketName: "test-bucket",
      clock: () => fixedNow,
      fetchFn: mockFailingFetch as typeof fetch,
    });

    expect(summary.decisions[0]?.action).toBe("terminate");
    expect(summary.decisions[0]?.reason).toContain("MicroVM unreachable for 4 consecutive polls");
    expect(microvmsMock.commandCalls(TerminateMicrovmCommand).length).toBe(1);
  });

  it("handles SuspendMicrovm throttling backoff gracefully", async () => {
    const fixedNow = new Date("2026-09-06T12:00:00Z").getTime();

    microvmsMock.on(ListMicrovmsCommand).resolves({
      items: [
        {
          microvmId: "vm-throttled-01",
          state: "RUNNING",
          imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner",
          imageVersion: "1.0",
          startedAt: new Date(fixedNow - 600_000),
        },
      ],
    });

    microvmsMock.on(GetMicrovmCommand).resolves({
      microvmId: "vm-throttled-01",
      state: "RUNNING",
      endpoint: "vm-throttled.endpoint",
      startedAt: new Date(fixedNow - 600_000),
    });

    s3Mock.on(GetObjectCommand).resolves({
      Body: mockS3Body(
        JSON.stringify({ runId: "run-throttled", status: "idle" }),
      ) as unknown as never,
    });

    microvmsMock.on(CreateMicrovmAuthTokenCommand).resolves({
      authToken: { "X-aws-proxy-auth": "token-test" },
    });

    // Throttled on first call, succeeds on retry
    const throttlingError = new Error("Rate exceeded");
    throttlingError.name = "ThrottlingException";

    microvmsMock.on(SuspendMicrovmCommand).rejectsOnce(throttlingError).resolves({});

    const mockFetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          status: "idle",
          runId: "run-throttled",
          agentState: "idle",
          idleSince: new Date(fixedNow - 200_000).toISOString(),
          suggestedAction: "suspend",
          policy: { idleGraceSec: 120 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const summary = await executeControllerRun({
      stackName: "test-stack",
      bucketName: "test-bucket",
      clock: () => fixedNow,
      fetchFn: mockFetch as typeof fetch,
    });

    expect(summary.decisions[0]?.action).toBe("suspend");
    expect(microvmsMock.commandCalls(SuspendMicrovmCommand).length).toBe(2);
  });

  it("supports DRY_RUN mode and skips state mutations while logging decisions", async () => {
    const fixedNow = new Date("2026-09-06T12:00:00Z").getTime();

    microvmsMock.on(ListMicrovmsCommand).resolves({
      items: [
        {
          microvmId: "vm-dryrun-01",
          state: "RUNNING",
          imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner",
          imageVersion: "1.0",
          startedAt: new Date(fixedNow - 600_000),
        },
      ],
    });

    microvmsMock.on(GetMicrovmCommand).resolves({
      microvmId: "vm-dryrun-01",
      state: "RUNNING",
      endpoint: "vm-dryrun.endpoint",
      startedAt: new Date(fixedNow - 600_000),
    });

    s3Mock.on(GetObjectCommand).resolves({
      Body: mockS3Body(
        JSON.stringify({ runId: "run-dryrun-01", status: "idle" }),
      ) as unknown as never,
    });

    microvmsMock.on(CreateMicrovmAuthTokenCommand).resolves({
      authToken: { "X-aws-proxy-auth": "token-dryrun" },
    });

    const mockFetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          status: "idle",
          runId: "run-dryrun-01",
          agentState: "idle",
          idleSince: new Date(fixedNow - 300_000).toISOString(),
          suggestedAction: "suspend",
          policy: { idleGraceSec: 120 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const summary = await executeControllerRun({
      stackName: "test-stack",
      bucketName: "test-bucket",
      dryRun: true,
      clock: () => fixedNow,
      fetchFn: mockFetch as typeof fetch,
    });

    expect(summary.dryRun).toBe(true);
    expect(summary.decisions[0]?.action).toBe("suspend");
    // No mutation should be executed in dry run mode
    expect(microvmsMock.commandCalls(SuspendMicrovmCommand).length).toBe(0);
    expect(microvmsMock.commandCalls(TerminateMicrovmCommand).length).toBe(0);
    expect(s3Mock.commandCalls(PutObjectCommand).length).toBe(0);
  });

  it("exports standard Lambda handler returning status 200 and JSON body", async () => {
    microvmsMock.on(ListMicrovmsCommand).resolves({ items: [] });
    s3Mock.on(PutObjectCommand).resolves({});

    const response = await handler({}, {});
    expect(response.statusCode).toBe(200);
    const parsed = JSON.parse(response.body);
    expect(parsed.runningCount).toBe(0);
    expect(parsed.decisions).toEqual([]);
  });

  it("paginates ListMicrovmsCommand and ListSecretsCommand across multiple pages", async () => {
    const fixedNow = new Date("2026-09-06T12:00:00Z").getTime();

    microvmsMock
      .on(ListMicrovmsCommand, { nextToken: undefined })
      .resolves({
        items: [
          {
            microvmId: "vm-page-1",
            state: "TERMINATED",
            imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner",
            imageVersion: "1.0",
            startedAt: new Date(fixedNow - 300_000),
          },
        ],
        nextToken: "page-2-token",
      })
      .on(ListMicrovmsCommand, { nextToken: "page-2-token" })
      .resolves({
        items: [
          {
            microvmId: "vm-page-2",
            state: "TERMINATED",
            imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner",
            imageVersion: "1.0",
            startedAt: new Date(fixedNow - 300_000),
          },
        ],
      });

    s3Mock
      .on(GetObjectCommand, { Bucket: "test-bucket", Key: "index/vm-page-1" })
      .resolves({
        Body: mockS3Body(JSON.stringify({ runId: "run-p1" })) as unknown as never,
      })
      .on(GetObjectCommand, { Bucket: "test-bucket", Key: "index/vm-page-2" })
      .resolves({
        Body: mockS3Body(JSON.stringify({ runId: "run-p2" })) as unknown as never,
      });

    // run-p1 has its secrets split across two ListSecrets pages; run-p2 has a single page.
    secretsMock
      .on(ListSecretsCommand, {
        NextToken: undefined,
        Filters: [{ Key: "name", Values: ["pi-cloud-agents/test-stack/runs/run-p1/"] }],
      })
      .resolves({
        SecretList: [{ Name: "pi-cloud-agents/test-stack/runs/run-p1/secret1" }],
        NextToken: "secrets-page-2",
      })
      .on(ListSecretsCommand, {
        NextToken: "secrets-page-2",
        Filters: [{ Key: "name", Values: ["pi-cloud-agents/test-stack/runs/run-p1/"] }],
      })
      .resolves({
        SecretList: [{ Name: "pi-cloud-agents/test-stack/runs/run-p1/secret2" }],
      })
      .on(ListSecretsCommand, {
        Filters: [{ Key: "name", Values: ["pi-cloud-agents/test-stack/runs/run-p2/"] }],
      })
      .resolves({
        SecretList: [{ Name: "pi-cloud-agents/test-stack/runs/run-p2/secret1" }],
      });

    secretsMock.on(DeleteSecretCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});
    s3Mock.on(PutObjectCommand).resolves({});

    const summary = await executeControllerRun({
      stackName: "test-stack",
      bucketName: "test-bucket",
      clock: () => fixedNow,
    });

    expect(summary.terminatedCount).toBe(2);
    expect(microvmsMock.commandCalls(ListMicrovmsCommand).length).toBe(2);
    expect(secretsMock.commandCalls(ListSecretsCommand).length).toBe(3);
    const deleted = secretsMock
      .commandCalls(DeleteSecretCommand)
      .map((call) => call.args[0].input.SecretId)
      .sort();
    expect(deleted).toEqual([
      "pi-cloud-agents/test-stack/runs/run-p1/secret1",
      "pi-cloud-agents/test-stack/runs/run-p1/secret2",
      "pi-cloud-agents/test-stack/runs/run-p2/secret1",
    ]);
    const p1Decision = summary.decisions.find((d) => d.runId === "run-p1");
    expect(p1Decision?.reason).toContain("Force-deleted 2 run-scoped secret(s)");
  });
});
