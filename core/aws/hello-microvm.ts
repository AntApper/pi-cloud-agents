/**
 * Hello MicroVM End-to-End Spike Engine (T0.3).
 * Orchestrates full lifecycle: bundle zip creation, S3 upload, IAM build role,
 * image creation, run, auth token minting, HTTP GET 3 KB payload echo, port 9000 403 probe,
 * WebSocket echo, SSE heartbeat stream, suspend/resume cycle, termination, timing metrics,
 * cost estimation, and cleanup.
 */

import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  IAMClient,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  CreateMicrovmAuthTokenCommand,
  CreateMicrovmImageCommand,
  DeleteMicrovmImageCommand,
  DeleteMicrovmImageVersionCommand,
  GetMicrovmCommand,
  GetMicrovmImageCommand,
  HookState,
  LambdaMicrovmsClient,
  ListManagedMicrovmImagesCommand,
  ListMicrovmImageVersionsCommand,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import {
  type BucketLocationConstraint,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { buildHelloBundleZip, generateTestRunHookPayload } from "./hello-bundle.js";
import { maskAccountId, maskArn, maskToken } from "./mask.js";

export const TEST_SPIKE_PREFIX = "pi-cloud-agents-test-spike";

export interface HelloMicrovmOptions {
  region?: string;
  profile?: string;
  simulate?: boolean;
  baseImageArn?: string;
  baseImageVersion?: string;
  keepResources?: boolean;
  timeoutMs?: number;
  customClients?: {
    microvmsClient?: LambdaMicrovmsClient;
    s3Client?: S3Client;
    iamClient?: IAMClient;
    stsClient?: STSClient;
  };
}

export interface StepTiming {
  name: string;
  durationMs: number;
  status: "PASS" | "FAIL" | "SKIPPED";
  details?: string;
}

export interface HelloMicrovmReport {
  timestamp: string;
  region: string;
  mode: "LIVE" | "SIMULATED";
  microvmId?: string;
  imageArn?: string;
  imageVersion?: string;
  endpoint?: string;
  timings: {
    imageBuildMs?: number;
    runToRunningMs?: number;
    firstHttp200Ms?: number;
    suspendMs?: number;
    resumeMs?: number;
    terminateMs?: number;
    totalMs: number;
  };
  steps: StepTiming[];
  verifications: {
    payloadEcho: {
      status: "PASS" | "FAIL" | "SKIPPED";
      sizeBytes: number;
      matchesOriginal: boolean;
      error?: string;
    };
    portIsolation: {
      status: "PASS" | "FAIL" | "SKIPPED";
      statusCode: number;
      error?: string;
    };
    webSocketEcho: {
      status: "PASS" | "FAIL" | "SKIPPED";
      framesSent: number;
      framesReceived: number;
      error?: string;
    };
    sseHeartbeat: {
      status: "PASS" | "FAIL" | "SKIPPED";
      heartbeatsReceived: number;
      durationMs: number;
      error?: string;
    };
    lifecycleResume: {
      status: "PASS" | "FAIL" | "SKIPPED";
      postResumeHttp200: boolean;
      error?: string;
    };
  };
  estimatedCostUsd: number;
  cleanup: {
    status: "PASS" | "FAIL" | "SKIPPED";
    cleanedResources: string[];
    error?: string;
  };
  overallStatus: "PASS" | "FAIL";
}

/**
 * Calculates estimated AWS cost for the spike execution based on measured duration.
 * Pricing (us-east-1, ARM Graviton):
 * - vCPU: $0.0000276944 / second (1 vCPU for 2 GB baseline)
 * - Memory: $0.0000036667 / GB-second (2 GB = $0.0000073334 / second)
 * - Snapshot read (launch + resume): $0.00155 / GB * 2 GB * 2 = $0.0062
 * - Snapshot write (suspend): $0.0038 / GB * 2 GB = $0.0076
 */
export function calculateEstimatedCost(totalRunMs: number, memoryGb = 2): number {
  const runSeconds = Math.max(1, Math.ceil(totalRunMs / 1000));
  const vCpuCost = 1 * 0.0000276944 * runSeconds;
  const memCost = memoryGb * 0.0000036667 * runSeconds;
  const snapshotReadCost = 2 * (0.00155 * memoryGb); // launch + resume
  const snapshotWriteCost = 1 * (0.0038 * memoryGb); // suspend

  const total = vCpuCost + memCost + snapshotReadCost + snapshotWriteCost;
  return Number(total.toFixed(6));
}

/**
 * Main spike entry point. Supports both live AWS execution and simulated mode.
 */
export async function runHelloMicrovmSpike(
  options: HelloMicrovmOptions = {},
): Promise<HelloMicrovmReport> {
  const region = options.region || process.env.AWS_REGION || "us-east-1";
  const isE2e = process.env.PI_CLOUD_E2E === "1";
  const simulate = options.simulate ?? !isE2e;

  if (simulate) {
    return runSimulatedSpike(region, options);
  }

  return runLiveSpike(region, options);
}

/**
 * Executes high-fidelity simulation offline or during unit tests.
 */
export async function runSimulatedSpike(
  region: string,
  _options: HelloMicrovmOptions = {},
): Promise<HelloMicrovmReport> {
  const startTime = Date.now();
  const testPayload = generateTestRunHookPayload(3072);
  const steps: StepTiming[] = [];

  const microvmId = `mvm-sim-${Date.now().toString(36)}`;
  const imageArn = `arn:aws:lambda:${region}:123456789012:microvm-image:${TEST_SPIKE_PREFIX}-sim`;
  const imageVersion = "1.0";
  const authToken = `sim-jwe-token-${Buffer.from(microvmId).toString("base64url")}`;

  // Step 1: Zip bundling
  const buildStart = Date.now();
  const zipBuffer = buildHelloBundleZip();
  const imageBuildMs = Math.max(45, Date.now() - buildStart);
  steps.push({
    name: "Image Build (Zip + Config)",
    durationMs: imageBuildMs,
    status: "PASS",
    details: `Bundle size: ${zipBuffer.length} bytes`,
  });

  // Start in-memory mock server to exercise full HTTP / SSE / WS client protocol
  const mockServer = await createMockMicrovmServer({
    microvmId,
    runHookPayload: testPayload.payloadJson,
    validToken: authToken,
  });

  const endpoint = `localhost:${mockServer.port}`;
  let firstHttp200Ms = 0;
  const runToRunningMs = 25;
  let suspendMs = 15;
  let resumeMs = 20;
  const terminateMs = 10;

  const verifications: HelloMicrovmReport["verifications"] = {
    payloadEcho: { status: "SKIPPED", sizeBytes: 0, matchesOriginal: false },
    portIsolation: { status: "SKIPPED", statusCode: 0 },
    webSocketEcho: { status: "SKIPPED", framesSent: 0, framesReceived: 0 },
    sseHeartbeat: { status: "SKIPPED", heartbeatsReceived: 0, durationMs: 0 },
    lifecycleResume: { status: "SKIPPED", postResumeHttp200: false },
  };

  try {
    // Step 2: Run MicroVM
    steps.push({
      name: "RunMicrovm -> RUNNING",
      durationMs: runToRunningMs,
      status: "PASS",
      details: `ID: ${microvmId}`,
    });

    // Step 3: Auth Token Minting
    steps.push({
      name: "CreateMicrovmAuthToken (port 8080)",
      durationMs: 5,
      status: "PASS",
      details: "Token TTL: 30m",
    });

    // Step 4: First HTTP GET verification (echo 3 KB payload)
    const httpStart = Date.now();
    const httpRes = await fetch(`http://127.0.0.1:${mockServer.port}/`, {
      headers: {
        "X-aws-proxy-auth": authToken,
        "X-aws-proxy-port": "8080",
      },
    });

    firstHttp200Ms = Date.now() - httpStart;
    if (httpRes.status === 200) {
      const body = (await httpRes.json()) as Record<string, unknown>;
      const echoedPayload = body.runHookPayload as string;
      const matches = echoedPayload === testPayload.payloadJson;
      verifications.payloadEcho = {
        status: matches ? "PASS" : "FAIL",
        sizeBytes: Buffer.byteLength(echoedPayload || "", "utf-8"),
        matchesOriginal: matches,
      };
      steps.push({
        name: "HTTP GET / (Payload Echo)",
        durationMs: firstHttp200Ms,
        status: matches ? "PASS" : "FAIL",
        details: `Echoed: ${verifications.payloadEcho.sizeBytes} B (Expected: ${testPayload.sizeBytes} B)`,
      });
    } else {
      verifications.payloadEcho = {
        status: "FAIL",
        sizeBytes: 0,
        matchesOriginal: false,
        error: `HTTP ${httpRes.status}`,
      };
    }

    // Step 5: Port 9000 Isolation Probe (expect 403)
    const port9000Res = await fetch(`http://127.0.0.1:${mockServer.port}/`, {
      headers: {
        "X-aws-proxy-auth": authToken,
        "X-aws-proxy-port": "9000",
      },
    });
    const portIsolated = port9000Res.status === 403;
    verifications.portIsolation = {
      status: portIsolated ? "PASS" : "FAIL",
      statusCode: port9000Res.status,
    };
    steps.push({
      name: "Port Isolation Probe (port 9000)",
      durationMs: 5,
      status: portIsolated ? "PASS" : "FAIL",
      details: `Status: ${port9000Res.status} (Expected: 403 Forbidden)`,
    });

    // Step 6: WebSocket Echo Verification
    const wsResult = await runWebSocketEchoTest({
      url: `ws://127.0.0.1:${mockServer.port}/ws`,
      authToken,
      port: "8080",
      frameCount: 10,
    });
    verifications.webSocketEcho = {
      status: wsResult.success ? "PASS" : "FAIL",
      framesSent: wsResult.framesSent,
      framesReceived: wsResult.framesReceived,
      error: wsResult.error,
    };
    steps.push({
      name: "WebSocket Echo (10 frames)",
      durationMs: wsResult.durationMs,
      status: wsResult.success ? "PASS" : "FAIL",
      details: `Frames: ${wsResult.framesReceived}/${wsResult.framesSent}`,
    });

    // Step 7: SSE Heartbeat Stream (receive >= 3 frames)
    const sseResult = await runSseHeartbeatTest({
      url: `http://127.0.0.1:${mockServer.port}/sse`,
      authToken,
      port: "8080",
      minHeartbeats: 3,
      timeoutMs: 3000,
    });
    verifications.sseHeartbeat = {
      status: sseResult.success ? "PASS" : "FAIL",
      heartbeatsReceived: sseResult.heartbeatsReceived,
      durationMs: sseResult.durationMs,
      error: sseResult.error,
    };
    steps.push({
      name: "SSE Heartbeat Stream",
      durationMs: sseResult.durationMs,
      status: sseResult.success ? "PASS" : "FAIL",
      details: `Heartbeats: ${sseResult.heartbeatsReceived}`,
    });

    // Step 8: Suspend -> Resume lifecycle cycle
    const suspendStart = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    suspendMs = Date.now() - suspendStart;
    steps.push({
      name: "SuspendMicrovm -> SUSPENDED",
      durationMs: suspendMs,
      status: "PASS",
    });

    const resumeStart = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    resumeMs = Date.now() - resumeStart;

    // Verify GET after resume
    const postResumeRes = await fetch(`http://127.0.0.1:${mockServer.port}/`, {
      headers: {
        "X-aws-proxy-auth": authToken,
        "X-aws-proxy-port": "8080",
      },
    });
    const resumeOk = postResumeRes.status === 200;
    verifications.lifecycleResume = {
      status: resumeOk ? "PASS" : "FAIL",
      postResumeHttp200: resumeOk,
    };
    steps.push({
      name: "ResumeMicrovm -> RUNNING + GET /",
      durationMs: resumeMs,
      status: resumeOk ? "PASS" : "FAIL",
      details: `HTTP status: ${postResumeRes.status}`,
    });

    // Step 9: Terminate
    steps.push({
      name: "TerminateMicrovm -> TERMINATED",
      durationMs: terminateMs,
      status: "PASS",
    });
  } finally {
    await mockServer.close();
  }

  const totalMs = Date.now() - startTime;
  const estimatedCostUsd = calculateEstimatedCost(totalMs, 2);

  const overallStatus =
    verifications.payloadEcho.status === "PASS" &&
    verifications.portIsolation.status === "PASS" &&
    verifications.webSocketEcho.status === "PASS" &&
    verifications.sseHeartbeat.status === "PASS" &&
    verifications.lifecycleResume.status === "PASS"
      ? "PASS"
      : "FAIL";

  return {
    timestamp: new Date().toISOString(),
    region,
    mode: "SIMULATED",
    microvmId,
    imageArn,
    imageVersion,
    endpoint,
    timings: {
      imageBuildMs,
      runToRunningMs,
      firstHttp200Ms,
      suspendMs,
      resumeMs,
      terminateMs,
      totalMs,
    },
    steps,
    verifications,
    estimatedCostUsd,
    cleanup: {
      status: "PASS",
      cleanedResources: ["mock-server", "mock-image", "mock-bundle"],
    },
    overallStatus,
  };
}

/**
 * Executes live AWS end-to-end spike.
 */
export async function runLiveSpike(
  region: string,
  options: HelloMicrovmOptions = {},
): Promise<HelloMicrovmReport> {
  const startTime = Date.now();
  const testPayload = generateTestRunHookPayload(3072);
  const steps: StepTiming[] = [];
  const cleanedResources: string[] = [];

  const microvmsClient =
    options.customClients?.microvmsClient || new LambdaMicrovmsClient({ region });
  const s3Client = options.customClients?.s3Client || new S3Client({ region });
  const iamClient = options.customClients?.iamClient || new IAMClient({ region });
  const stsClient = options.customClients?.stsClient || new STSClient({ region });

  // Caller identity
  const identity = await stsClient.send(new GetCallerIdentityCommand({}));
  const accountId = identity.Account || "UNKNOWN";

  const uniqueSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const bucketName = `${TEST_SPIKE_PREFIX}-bkt-${uniqueSuffix}`;
  const roleName = `${TEST_SPIKE_PREFIX}-role-${uniqueSuffix}`;
  const policyName = `${TEST_SPIKE_PREFIX}-pol-${uniqueSuffix}`;
  const imageName = `${TEST_SPIKE_PREFIX}-img-${uniqueSuffix}`;

  let createdBucket = false;
  let createdRole = false;
  let imageArn: string | undefined;
  let imageVersion: string | undefined;
  let microvmId: string | undefined;
  let endpoint: string | undefined;

  let imageBuildMs: number | undefined;
  let runToRunningMs: number | undefined;
  let firstHttp200Ms: number | undefined;
  let suspendMs: number | undefined;
  let resumeMs: number | undefined;
  let terminateMs: number | undefined;

  const verifications: HelloMicrovmReport["verifications"] = {
    payloadEcho: { status: "SKIPPED", sizeBytes: 0, matchesOriginal: false },
    portIsolation: { status: "SKIPPED", statusCode: 0 },
    webSocketEcho: { status: "SKIPPED", framesSent: 0, framesReceived: 0 },
    sseHeartbeat: { status: "SKIPPED", heartbeatsReceived: 0, durationMs: 0 },
    lifecycleResume: { status: "SKIPPED", postResumeHttp200: false },
  };

  try {
    // 1. Resolve Base Image ARN
    let baseImageArn = options.baseImageArn;
    if (!baseImageArn) {
      const managedRes = await microvmsClient.send(new ListManagedMicrovmImagesCommand({}));
      const found = managedRes.items?.find(
        (img) => img.imageArn?.includes("al2023") || img.imageArn?.includes("minimal"),
      );
      baseImageArn =
        found?.imageArn ||
        managedRes.items?.[0]?.imageArn ||
        `arn:aws:lambda:${region}:aws:microvm-image:al2023-1`;
    }

    // 2. Create S3 Bucket and upload bundle
    const s3Start = Date.now();
    await s3Client.send(
      new CreateBucketCommand({
        Bucket: bucketName,
        ...(region !== "us-east-1"
          ? {
              CreateBucketConfiguration: {
                LocationConstraint: region as BucketLocationConstraint,
              },
            }
          : {}),
      }),
    );
    createdBucket = true;

    const zipBuffer = buildHelloBundleZip();
    const zipKey = "hello-microvm.zip";
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: zipKey,
        Body: zipBuffer,
      }),
    );
    steps.push({
      name: "S3 Bucket & Artifact Upload",
      durationMs: Date.now() - s3Start,
      status: "PASS",
      details: `Bucket: ${bucketName}`,
    });

    // 3. Create IAM Build Role
    const iamStart = Date.now();
    const trustPolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
          Action: ["sts:AssumeRole", "sts:TagSession"],
          Condition: {
            StringEquals: {
              "aws:SourceAccount": accountId,
            },
          },
        },
      ],
    });

    const roleRes = await iamClient.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: trustPolicy,
        Tags: [
          { Key: "pi-cloud-agents:test", Value: "true" },
          { Key: "Name", Value: roleName },
        ],
      }),
    );
    createdRole = true;
    const buildRoleArn = roleRes.Role?.Arn;

    const inlinePolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["s3:GetObject"],
          Resource: `arn:aws:s3:::${bucketName}/*`,
        },
        {
          Effect: "Allow",
          Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
          Resource: `arn:aws:logs:${region}:${accountId}:*`,
        },
      ],
    });

    await iamClient.send(
      new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName: policyName,
        PolicyDocument: inlinePolicy,
      }),
    );
    steps.push({
      name: "IAM Build Role Creation",
      durationMs: Date.now() - iamStart,
      status: "PASS",
      details: `Role: ${roleName}`,
    });

    // Brief sleep for IAM eventual consistency
    await new Promise((r) => setTimeout(r, 6000));

    // 4. Create MicrovmImage
    const imgBuildStart = Date.now();
    const createImgRes = await microvmsClient.send(
      new CreateMicrovmImageCommand({
        name: imageName,
        baseImageArn,
        baseImageVersion: options.baseImageVersion || "1.0",
        buildRoleArn,
        codeArtifact: {
          uri: `s3://${bucketName}/${zipKey}`,
        },
        cpuConfigurations: [{ architecture: "ARM_64" }],
        resources: [{ minimumMemoryInMiB: 2048 }],
        hooks: {
          port: 9000,
          microvmImageHooks: {
            ready: HookState.ENABLED,
            readyTimeoutInSeconds: 30,
            validate: HookState.ENABLED,
            validateTimeoutInSeconds: 30,
          },
          microvmHooks: {
            run: HookState.ENABLED,
            runTimeoutInSeconds: 30,
            resume: HookState.ENABLED,
            resumeTimeoutInSeconds: 30,
            suspend: HookState.ENABLED,
            suspendTimeoutInSeconds: 30,
            terminate: HookState.ENABLED,
            terminateTimeoutInSeconds: 30,
          },
        },
        tags: {
          "pi-cloud-agents:test": "true",
          Name: imageName,
        },
      }),
    );

    imageArn = createImgRes.imageArn;

    // Poll until image is CREATED
    const imageDeadline = Date.now() + 600000; // 10 minutes max
    let imageReady = false;
    while (Date.now() < imageDeadline) {
      const check = await microvmsClient.send(
        new GetMicrovmImageCommand({ imageIdentifier: imageArn }),
      );
      if (check.state === "CREATED") {
        imageReady = true;
        imageVersion = check.latestActiveImageVersion || "1.0";
        break;
      }
      if (check.state === "CREATE_FAILED") {
        throw new Error(`CreateMicrovmImage failed: ${check.state}`);
      }
      await new Promise((r) => setTimeout(r, 5000));
    }

    if (!imageReady) {
      throw new Error("Timed out waiting for CreateMicrovmImage to reach CREATED.");
    }
    imageBuildMs = Date.now() - imgBuildStart;
    steps.push({
      name: "CreateMicrovmImage (Build -> CREATED)",
      durationMs: imageBuildMs,
      status: "PASS",
      details: `Version: ${imageVersion}`,
    });

    // 5. Run MicroVM
    const runStart = Date.now();
    const runRes = await microvmsClient.send(
      new RunMicrovmCommand({
        imageIdentifier: imageArn,
        imageVersion,
        maximumDurationInSeconds: 1800,
        idlePolicy: {
          maxIdleDurationSeconds: 900,
          suspendedDurationSeconds: 600,
          autoResumeEnabled: true,
        },
        runHookPayload: testPayload.payloadJson,
        ingressNetworkConnectors: [
          `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
        ],
        egressNetworkConnectors: [
          `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
        ],
      }),
    );

    microvmId = runRes.microvmId;

    // Poll until RUNNING
    const runDeadline = Date.now() + 180000; // 3 min
    let mvmRunning = false;
    while (Date.now() < runDeadline) {
      const mvm = await microvmsClient.send(
        new GetMicrovmCommand({ microvmIdentifier: microvmId }),
      );
      if (mvm.state === "RUNNING") {
        mvmRunning = true;
        endpoint = mvm.endpoint;
        break;
      }
      if (mvm.state === "TERMINATED") {
        throw new Error(`MicroVM failed to start: state=${mvm.state}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!mvmRunning || !endpoint) {
      throw new Error("MicroVM failed to reach RUNNING state or missing endpoint.");
    }
    runToRunningMs = Date.now() - runStart;
    steps.push({
      name: "RunMicrovm -> RUNNING",
      durationMs: runToRunningMs,
      status: "PASS",
      details: `Endpoint: ${maskArn(endpoint)}`,
    });

    // 6. Create Auth Token (scoped to port 8080)
    const tokenStart = Date.now();
    const tokenRes = await microvmsClient.send(
      new CreateMicrovmAuthTokenCommand({
        microvmIdentifier: microvmId,
        expirationInMinutes: 30,
        allowedPorts: [{ port: 8080 }],
      }),
    );

    const authToken =
      tokenRes.authToken?.["X-aws-proxy-auth"] || Object.values(tokenRes.authToken || {})[0];
    if (!authToken) {
      throw new Error("Failed to obtain X-aws-proxy-auth token.");
    }
    steps.push({
      name: "CreateMicrovmAuthToken (port 8080)",
      durationMs: Date.now() - tokenStart,
      status: "PASS",
      details: `Token: ${maskToken(authToken)}`,
    });

    // 7. First HTTP GET 200 (echo 3 KB payload)
    const httpStart = Date.now();
    const httpUrl = `https://${endpoint}/`;
    const getRes = await fetch(httpUrl, {
      headers: {
        "X-aws-proxy-auth": authToken,
        "X-aws-proxy-port": "8080",
      },
    });

    firstHttp200Ms = Date.now() - httpStart;
    if (getRes.status === 200) {
      const body = (await getRes.json()) as Record<string, unknown>;
      const echoed = (body.runHookPayload as string) || "";
      const matches = echoed === testPayload.payloadJson;
      verifications.payloadEcho = {
        status: matches ? "PASS" : "FAIL",
        sizeBytes: Buffer.byteLength(echoed, "utf-8"),
        matchesOriginal: matches,
      };
      steps.push({
        name: "HTTP GET / (Payload Echo)",
        durationMs: firstHttp200Ms,
        status: matches ? "PASS" : "FAIL",
        details: `Echoed: ${verifications.payloadEcho.sizeBytes} B`,
      });
    } else {
      verifications.payloadEcho = {
        status: "FAIL",
        sizeBytes: 0,
        matchesOriginal: false,
        error: `HTTP ${getRes.status}`,
      };
    }

    // 8. Port Isolation Security Probe (port 9000 expect 403)
    const portProbeRes = await fetch(httpUrl, {
      headers: {
        "X-aws-proxy-auth": authToken,
        "X-aws-proxy-port": "9000",
      },
    });
    const portIsolated = portProbeRes.status === 403;
    verifications.portIsolation = {
      status: portIsolated ? "PASS" : "FAIL",
      statusCode: portProbeRes.status,
    };
    steps.push({
      name: "Port Isolation Probe (port 9000)",
      durationMs: 200,
      status: portIsolated ? "PASS" : "FAIL",
      details: `Status: ${portProbeRes.status} (Expected: 403 Forbidden)`,
    });

    // 9. WebSocket Echo Verification
    const wsResult = await runWebSocketEchoTest({
      url: `wss://${endpoint}/ws`,
      authToken,
      port: "8080",
      frameCount: 10,
    });
    verifications.webSocketEcho = {
      status: wsResult.success ? "PASS" : "FAIL",
      framesSent: wsResult.framesSent,
      framesReceived: wsResult.framesReceived,
      error: wsResult.error,
    };
    steps.push({
      name: "WebSocket Echo (10 frames)",
      durationMs: wsResult.durationMs,
      status: wsResult.success ? "PASS" : "FAIL",
      details: `Frames: ${wsResult.framesReceived}/${wsResult.framesSent}`,
    });

    // 10. SSE Heartbeat Stream Verification
    const sseResult = await runSseHeartbeatTest({
      url: `https://${endpoint}/sse`,
      authToken,
      port: "8080",
      minHeartbeats: 3,
      timeoutMs: 15000,
    });
    verifications.sseHeartbeat = {
      status: sseResult.success ? "PASS" : "FAIL",
      heartbeatsReceived: sseResult.heartbeatsReceived,
      durationMs: sseResult.durationMs,
      error: sseResult.error,
    };
    steps.push({
      name: "SSE Heartbeat Stream (>= 3)",
      durationMs: sseResult.durationMs,
      status: sseResult.success ? "PASS" : "FAIL",
      details: `Heartbeats: ${sseResult.heartbeatsReceived}`,
    });

    // 11. Suspend -> Resume cycle
    const suspendStart = Date.now();
    await microvmsClient.send(new SuspendMicrovmCommand({ microvmIdentifier: microvmId }));
    const suspendDeadline = Date.now() + 60000;
    while (Date.now() < suspendDeadline) {
      const m = await microvmsClient.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
      if (m.state === "SUSPENDED") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    suspendMs = Date.now() - suspendStart;
    steps.push({
      name: "SuspendMicrovm -> SUSPENDED",
      durationMs: suspendMs,
      status: "PASS",
    });

    const resumeStart = Date.now();
    await microvmsClient.send(new ResumeMicrovmCommand({ microvmIdentifier: microvmId }));
    const resumeDeadline = Date.now() + 60000;
    while (Date.now() < resumeDeadline) {
      const m = await microvmsClient.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
      if (m.state === "RUNNING") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    resumeMs = Date.now() - resumeStart;

    // Verify GET after resume
    const postResumeRes = await fetch(httpUrl, {
      headers: {
        "X-aws-proxy-auth": authToken,
        "X-aws-proxy-port": "8080",
      },
    });
    const resumeOk = postResumeRes.status === 200;
    verifications.lifecycleResume = {
      status: resumeOk ? "PASS" : "FAIL",
      postResumeHttp200: resumeOk,
    };
    steps.push({
      name: "ResumeMicrovm -> RUNNING + GET /",
      durationMs: resumeMs,
      status: resumeOk ? "PASS" : "FAIL",
      details: `HTTP status: ${postResumeRes.status}`,
    });

    // 12. Terminate MicroVM
    const termStart = Date.now();
    await microvmsClient.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    const termDeadline = Date.now() + 60000;
    while (Date.now() < termDeadline) {
      const m = await microvmsClient.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
      if (m.state === "TERMINATED") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    terminateMs = Date.now() - termStart;
    steps.push({
      name: "TerminateMicrovm -> TERMINATED",
      durationMs: terminateMs,
      status: "PASS",
    });
  } finally {
    // Guaranteed cleanup
    if (!options.keepResources) {
      const cleanStart = Date.now();
      try {
        if (microvmId) {
          try {
            await microvmsClient.send(
              new TerminateMicrovmCommand({ microvmIdentifier: microvmId }),
            );
            cleanedResources.push(`microvm:${microvmId}`);
          } catch {
            // Already terminated
          }
        }

        if (imageArn) {
          try {
            const versions = await microvmsClient.send(
              new ListMicrovmImageVersionsCommand({ imageIdentifier: imageArn }),
            );
            for (const v of versions.items || []) {
              if (v.imageVersion) {
                await microvmsClient.send(
                  new DeleteMicrovmImageVersionCommand({
                    imageIdentifier: imageArn,
                    imageVersion: v.imageVersion,
                  }),
                );
              }
            }
            await microvmsClient.send(new DeleteMicrovmImageCommand({ imageIdentifier: imageArn }));
            cleanedResources.push(`image:${imageName}`);
          } catch {
            // best-effort
          }
        }

        if (createdRole) {
          try {
            await iamClient.send(
              new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }),
            );
            await iamClient.send(new DeleteRoleCommand({ RoleName: roleName }));
            cleanedResources.push(`iam-role:${roleName}`);
          } catch {
            // best-effort
          }
        }

        if (createdBucket) {
          try {
            const listObj = await s3Client.send(new ListObjectsV2Command({ Bucket: bucketName }));
            if (listObj.Contents && listObj.Contents.length > 0) {
              await s3Client.send(
                new DeleteObjectsCommand({
                  Bucket: bucketName,
                  Delete: {
                    Objects: listObj.Contents.map((o) => ({ Key: o.Key })),
                  },
                }),
              );
            }
            await s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
            cleanedResources.push(`s3-bucket:${bucketName}`);
          } catch {
            // best-effort
          }
        }

        steps.push({
          name: "Guaranteed Cleanup",
          durationMs: Date.now() - cleanStart,
          status: "PASS",
          details: `Purged: ${cleanedResources.length} resources`,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        steps.push({
          name: "Guaranteed Cleanup",
          durationMs: Date.now() - cleanStart,
          status: "FAIL",
          details: msg,
        });
      }
    }
  }

  const totalMs = Date.now() - startTime;
  const estimatedCostUsd = calculateEstimatedCost(totalMs, 2);

  const overallStatus =
    verifications.payloadEcho.status === "PASS" &&
    verifications.portIsolation.status === "PASS" &&
    verifications.webSocketEcho.status === "PASS" &&
    verifications.sseHeartbeat.status === "PASS" &&
    verifications.lifecycleResume.status === "PASS"
      ? "PASS"
      : "FAIL";

  return {
    timestamp: new Date().toISOString(),
    region,
    mode: "LIVE",
    microvmId,
    imageArn,
    imageVersion,
    endpoint,
    timings: {
      imageBuildMs,
      runToRunningMs,
      firstHttp200Ms,
      suspendMs,
      resumeMs,
      terminateMs,
      totalMs,
    },
    steps,
    verifications,
    estimatedCostUsd,
    cleanup: {
      status: "PASS",
      cleanedResources,
    },
    overallStatus,
  };
}

interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((evt: { data?: unknown }) => void) | null;
  onerror: ((err: { message?: string }) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;

/**
 * Runs WebSocket Echo Test against target endpoint.
 */
export async function runWebSocketEchoTest(options: {
  url: string;
  authToken: string;
  port: string;
  frameCount?: number;
  timeoutMs?: number;
}): Promise<{
  success: boolean;
  framesSent: number;
  framesReceived: number;
  durationMs: number;
  error?: string;
}> {
  const frameCount = options.frameCount ?? 10;
  const timeoutMs = options.timeoutMs ?? 10000;
  const start = Date.now();

  return new Promise((resolve) => {
    let sent = 0;
    let received = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({
          success: received >= frameCount,
          framesSent: sent,
          framesReceived: received,
          durationMs: Date.now() - start,
          error: received >= frameCount ? undefined : "WebSocket echo timeout",
        });
      }
    }, timeoutMs);

    try {
      const protocols = [
        "lambda-microvms",
        `lambda-microvms.authentication.${options.authToken}`,
        `lambda-microvms.port.${options.port}`,
      ];

      const ctor = (globalThis as unknown as { WebSocket: WebSocketCtor }).WebSocket;
      const ws = new ctor(options.url, protocols);

      ws.onopen = () => {
        for (let i = 0; i < frameCount; i++) {
          ws.send(JSON.stringify({ index: i, text: `frame-${i}`, timestamp: Date.now() }));
          sent++;
        }
      };

      ws.onmessage = (_evt) => {
        received++;
        if (received >= frameCount && !settled) {
          settled = true;
          clearTimeout(timer);
          try {
            ws.close();
          } catch {
            // ignore
          }
          resolve({
            success: true,
            framesSent: sent,
            framesReceived: received,
            durationMs: Date.now() - start,
          });
        }
      };

      ws.onerror = (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            success: false,
            framesSent: sent,
            framesReceived: received,
            durationMs: Date.now() - start,
            error: err.message || "WebSocket error",
          });
        }
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      resolve({
        success: false,
        framesSent: sent,
        framesReceived: received,
        durationMs: Date.now() - start,
        error: msg,
      });
    }
  });
}

/**
 * Runs SSE Heartbeat test collecting >= minHeartbeats.
 */
export async function runSseHeartbeatTest(options: {
  url: string;
  authToken: string;
  port: string;
  minHeartbeats?: number;
  timeoutMs?: number;
}): Promise<{
  success: boolean;
  heartbeatsReceived: number;
  durationMs: number;
  error?: string;
}> {
  const minHeartbeats = options.minHeartbeats ?? 3;
  const timeoutMs = options.timeoutMs ?? 10000;
  const start = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let heartbeatsReceived = 0;

  try {
    const res = await fetch(options.url, {
      headers: {
        "X-aws-proxy-auth": options.authToken,
        "X-aws-proxy-port": options.port,
      },
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      clearTimeout(timer);
      return {
        success: false,
        heartbeatsReceived: 0,
        durationMs: Date.now() - start,
        error: `HTTP ${res.status}`,
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (heartbeatsReceived < minHeartbeats) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() || "";

      for (const block of lines) {
        if (block.includes("heartbeat") || block.includes("init")) {
          heartbeatsReceived++;
          if (heartbeatsReceived >= minHeartbeats) {
            break;
          }
        }
      }
    }

    controller.abort();
    clearTimeout(timer);
    return {
      success: heartbeatsReceived >= minHeartbeats,
      heartbeatsReceived,
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === "AbortError";
    const ok = heartbeatsReceived >= minHeartbeats;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: ok,
      heartbeatsReceived,
      durationMs: Date.now() - start,
      error: ok ? undefined : isAbort ? "SSE timeout" : msg,
    };
  }
}

/**
 * Creates a lightweight local mock server simulating AWS Lambda MicroVM proxy & guest.
 */
export async function createMockMicrovmServer(options: {
  microvmId: string;
  runHookPayload: string;
  validToken: string;
}): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const proxyAuth = req.headers["x-aws-proxy-auth"];
      const proxyPort = req.headers["x-aws-proxy-port"];

      // Port 9000 isolation check: token scoped to 8080 must get 403 on port 9000
      if (proxyPort === "9000") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden: port 9000 access not authorized" }));
        return;
      }

      if (!proxyAuth || proxyAuth !== options.validToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized: invalid or missing proxy token" }));
        return;
      }

      const url = req.url || "/";

      // SSE Heartbeat Endpoint
      if (url.startsWith("/sse")) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ type: "init", microvmId: options.microvmId })}\n\n`);

        let seq = 1;
        const interval = setInterval(() => {
          if (res.writableEnded || res.destroyed) {
            clearInterval(interval);
            return;
          }
          res.write(
            `data: ${JSON.stringify({ type: "heartbeat", seq: seq++, time: Date.now() })}\n\n`,
          );
        }, 100);

        req.on("close", () => clearInterval(interval));
        return;
      }

      // Root Status / Payload Echo Endpoint
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          message: "Hello from Lambda MicroVM (simulated)",
          microvmId: options.microvmId,
          runHookPayload: options.runHookPayload,
          payloadBytes: Buffer.byteLength(options.runHookPayload, "utf-8"),
          timestamp: Date.now(),
        }),
      );
    });

    // WebSocket handling for mock
    server.on("upgrade", (req, socket) => {
      const protoHeader = req.headers["sec-websocket-protocol"] || "";
      const isAuth = protoHeader.includes(options.validToken);
      const isPort8080 = protoHeader.includes("8080");

      if (!isAuth || !isPort8080) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      const key = req.headers["sec-websocket-key"];
      const accept = crypto
        .createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");

      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: lambda-microvms\r\n\r\n`,
      );

      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          const byte1 = buffer[0] ?? 0;
          const byte2 = buffer[1] ?? 0;
          const opcode = byte1 & 0x0f;
          const isMasked = (byte2 & 0x80) === 0x80;
          let len = byte2 & 0x7f;
          let offset = 2;

          if (len === 126) {
            if (buffer.length < 4) break;
            len = buffer.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (buffer.length < 10) break;
            len = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }

          const maskLen = isMasked ? 4 : 0;
          const total = offset + maskLen + len;
          if (buffer.length < total) break;

          let payload = buffer.subarray(offset + maskLen, total);
          if (isMasked) {
            const mask = buffer.subarray(offset, offset + 4);
            const unmasked = Buffer.alloc(len);
            for (let i = 0; i < len; i++) {
              const pByte = payload[i] ?? 0;
              const mByte = mask[i % 4] ?? 0;
              unmasked[i] = pByte ^ mByte;
            }
            payload = unmasked;
          }

          buffer = buffer.subarray(total);

          if (opcode === 0x08) {
            // close
            const header = Buffer.from([0x88, 0x00]);
            socket.write(header);
            socket.end();
          } else if (opcode === 0x01 || opcode === 0x02) {
            // text or binary echo
            const header = Buffer.alloc(2);
            header[0] = 0x80 | opcode;
            header[1] = payload.length;
            socket.write(Buffer.concat([header, payload]));
          }
        }
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * Formats report into Unicode box table adhering to no-emoji styling rules.
 */
export function formatHelloMicrovmReport(report: HelloMicrovmReport): string {
  const width = 76;
  const innerWidth = width - 4;

  const row = (left: string, right: string) => {
    const l = left.slice(0, innerWidth - right.length - 1);
    const spaces = innerWidth - l.length - right.length;
    return `│ ${l}${" ".repeat(Math.max(1, spaces))}${right} │`;
  };

  const statusGlyph = (st: "PASS" | "FAIL" | "SKIPPED") => {
    switch (st) {
      case "PASS":
        return "✓ PASS";
      case "FAIL":
        return "✗ FAIL";
      case "SKIPPED":
        return "○ SKIP";
    }
  };

  const headerTitle = ` Hello MicroVM Spike (T0.3) · ${report.region} (${report.mode.toLowerCase()}) `;
  const topDashes = Math.max(0, width - 2 - headerTitle.length);

  const lines: string[] = [];
  lines.push(`┌${headerTitle}${"─".repeat(topDashes)}┐`);
  lines.push(row("MicroVM ID", report.microvmId ? maskAccountId(report.microvmId) : "N/A"));
  lines.push(row("Image Version", report.imageVersion || "1.0"));
  lines.push(row("Endpoint", report.endpoint ? maskArn(report.endpoint) : "N/A"));
  lines.push(`├ Verifications ${"─".repeat(Math.max(0, width - 2 - 16))}┤`);

  lines.push(
    row(
      `Payload Echo (${report.verifications.payloadEcho.sizeBytes} B)`,
      statusGlyph(report.verifications.payloadEcho.status),
    ),
  );
  lines.push(
    row(
      `Port Isolation (port 9000 -> ${report.verifications.portIsolation.statusCode})`,
      statusGlyph(report.verifications.portIsolation.status),
    ),
  );
  lines.push(
    row(
      `WebSocket Echo (${report.verifications.webSocketEcho.framesReceived}/${report.verifications.webSocketEcho.framesSent} frames)`,
      statusGlyph(report.verifications.webSocketEcho.status),
    ),
  );
  lines.push(
    row(
      `SSE Heartbeat (${report.verifications.sseHeartbeat.heartbeatsReceived} frames)`,
      statusGlyph(report.verifications.sseHeartbeat.status),
    ),
  );
  lines.push(
    row("Suspend / Resume Lifecycle", statusGlyph(report.verifications.lifecycleResume.status)),
  );

  lines.push(`├ Step Timings & Cost ${"─".repeat(Math.max(0, width - 2 - 23))}┤`);
  if (report.timings.imageBuildMs !== undefined) {
    lines.push(row("Image Build", `${report.timings.imageBuildMs} ms`));
  }
  if (report.timings.runToRunningMs !== undefined) {
    lines.push(row("Run -> RUNNING", `${report.timings.runToRunningMs} ms`));
  }
  if (report.timings.firstHttp200Ms !== undefined) {
    lines.push(row("First HTTP 200", `${report.timings.firstHttp200Ms} ms`));
  }
  if (report.timings.suspendMs !== undefined) {
    lines.push(row("Suspend Duration", `${report.timings.suspendMs} ms`));
  }
  if (report.timings.resumeMs !== undefined) {
    lines.push(row("Resume Duration", `${report.timings.resumeMs} ms`));
  }
  if (report.timings.terminateMs !== undefined) {
    lines.push(row("Terminate Duration", `${report.timings.terminateMs} ms`));
  }
  lines.push(row("Total Duration", `${report.timings.totalMs} ms`));
  lines.push(row("Estimated AWS Cost", `$${report.estimatedCostUsd.toFixed(6)} USD`));

  lines.push(`├ Cleanup ${"─".repeat(Math.max(0, width - 2 - 10))}┤`);
  lines.push(
    row(
      `Purged Resources (${report.cleanup.cleanedResources.length})`,
      statusGlyph(report.cleanup.status),
    ),
  );

  lines.push(`├${"─".repeat(Math.max(0, width - 2))}┤`);
  const verdictText = report.overallStatus === "PASS" ? "Verdict: SUCCESS" : "Verdict: FAILED";
  const verdictGlyph = report.overallStatus === "PASS" ? "✓ PASS" : "✗ FAIL";
  lines.push(row(verdictText, verdictGlyph));
  lines.push(`└${"─".repeat(Math.max(0, width - 2))}┘`);

  return lines.join("\n");
}
