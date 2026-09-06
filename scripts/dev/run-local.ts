/**
 * Local Harness for in-VM runner development and zero-cost testing (T2.8).
 * Sets up:
 *  - Temporary run directory (.tmp/runs/<runId>)
 *  - Local bare Git repository with an initial commit
 *  - Deterministic Pi config bundle with mock-llm configuration
 *  - FakeSecretsProvider with fake secrets & token
 *  - LocalStorageSink for manifest & session mirroring
 *  - RunnerServer listening on lifecycle hook port (default 9000) and API port (default 8080)
 *  - Dispatches POST /run hook and waits until ready.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDeterministicTar } from "../../core/pi-config.js";
import { RunnerServer } from "../../runner/main.js";
import { FakeSecretsProvider } from "../../runner/secrets.js";
import { LocalStorageSink } from "../../runner/storage.js";
import { type LaunchPayload, encodeLaunchPayload } from "../../shared/protocol.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");

export const DEFAULT_FAKE_SECRET_TOKEN = "super-secret-token-12345";
export const DEFAULT_MOCK_API_KEY = "mock-key-secret-99999";

export interface LocalHarnessOptions {
  runId?: string;
  baseDir?: string;
  hookPort?: number;
  apiPort?: number;
  piBinary?: string;
  secretToken?: string;
  autoRunHook?: boolean;
}

export interface LocalHarnessInstance {
  runId: string;
  baseDir: string;
  bareRepoDir: string;
  bareRepoUrl: string;
  workBranch: string;
  hookPort: number;
  apiPort: number;
  secretToken: string;
  runner: RunnerServer;
  storageSink: LocalStorageSink;
  cleanup: () => Promise<void>;
}

/**
 * Creates and starts a complete local runner harness.
 */
export async function startLocalHarness(
  options: LocalHarnessOptions = {},
): Promise<LocalHarnessInstance> {
  const timestamp = Date.now();
  const runId = options.runId ?? `run-local-${timestamp}`;
  const baseDir = options.baseDir ?? path.join(REPO_ROOT, ".tmp", "runs", runId);
  const hookPort = options.hookPort ?? 9000;
  const apiPort = options.apiPort ?? 8080;
  const secretToken = options.secretToken ?? DEFAULT_FAKE_SECRET_TOKEN;
  const workBranch = `pi-cloud/${runId}`;

  // 1. Prepare clean base directory
  fs.mkdirSync(baseDir, { recursive: true });

  // 2. Set up local bare Git repository and initial commit
  const bareRepoDir = path.join(baseDir, "remote.git");
  execFileSync("git", ["init", "--bare", bareRepoDir]);

  const seedDir = path.join(baseDir, "seed");
  fs.mkdirSync(seedDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: seedDir });
  execFileSync("git", ["config", "user.name", "pi-cloud-agents[bot]"], { cwd: seedDir });
  execFileSync("git", ["config", "user.email", "bot@pi-cloud.local"], { cwd: seedDir });
  fs.writeFileSync(
    path.join(seedDir, "README.md"),
    `# Local Test Repository for ${runId}\n`,
    "utf8",
  );
  execFileSync("git", ["add", "."], { cwd: seedDir });
  execFileSync("git", ["commit", "-m", "Initial commit on main"], { cwd: seedDir });
  execFileSync("git", ["branch", "-M", "main"], { cwd: seedDir });
  execFileSync("git", ["remote", "add", "origin", bareRepoDir], { cwd: seedDir });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: seedDir });

  // 3. Prepare storage sink
  const storageBaseDir = path.join(REPO_ROOT, ".tmp", "runs");
  fs.mkdirSync(storageBaseDir, { recursive: true });
  const storageSink = new LocalStorageSink({ baseDir: storageBaseDir });

  // 4. Create and upload pi config bundle
  const bundleKey = `config/${runId}/bundle.tar`;
  const bundleTar = createDeterministicTar([
    {
      name: "models.json",
      content: JSON.stringify(
        {
          providers: {
            "mock-llm": {
              name: "Mock LLM Provider",
              baseUrl: "mock://localhost",
              api: "mock-llm-api",
              models: [
                {
                  id: "scripted",
                  name: "Scripted Mock Model",
                  contextWindow: 128000,
                  maxTokens: 4096,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
        null,
        2,
      ),
    },
    {
      name: "settings.json",
      content: JSON.stringify(
        {
          defaultProvider: "mock-llm",
          defaultModel: "scripted",
        },
        null,
        2,
      ),
    },
    {
      name: "AGENTS.md",
      content: `# Local Harness Agent (${runId})\n`,
    },
  ]);

  await storageSink.putObject(bundleKey, bundleTar, "application/x-tar");

  // 5. Configure fake secrets
  const secrets = new Map<string, string>([
    ["pi-cloud-agents/pi-cloud-agents-core/github/token", secretToken],
    [
      "pi-cloud-agents/pi-cloud-agents-core/pi-auth/mock-llm",
      JSON.stringify({ type: "api_key", key: DEFAULT_MOCK_API_KEY }),
    ],
    [
      "pi-cloud-agents/pi-cloud-agents-core/pi-auth/anthropic",
      JSON.stringify({ type: "api_key", key: "fake-anthropic-key-99999" }),
    ],
  ]);
  const secretsProvider = new FakeSecretsProvider(secrets);

  // 6. Resolve extension path for mock-llm
  const mockLlmExtPath = path.resolve(REPO_ROOT, "runner", "pi-extensions", "mock-llm.ts");

  // 7. Instantiate and start RunnerServer
  const runner = new RunnerServer({
    hookPort,
    apiPort,
    storageSink,
    secretsProvider,
    workDir: path.join(baseDir, "work", "repo"),
    piAgentDir: path.join(baseDir, ".pi-agent"),
    sessionDir: path.join(baseDir, ".pi-sessions"),
    piBinary: options.piBinary,
    extensions: [mockLlmExtPath],
  });

  const { hookPort: boundHookPort } = await runner.start();

  // 8. Construct LaunchPayload
  const payload: LaunchPayload = {
    v: 1,
    runId,
    owner: "arn:aws:iam::123456789012:user/alice",
    stack: {
      name: "pi-cloud-agents-core",
      region: "us-east-1",
      bucket: "local-runs",
    },
    repo: {
      url: `file://${bareRepoDir}`,
      ref: "main",
      workBranch,
    },
    model: {
      provider: "mock-llm",
      id: "scripted",
    },
    piConfig: {
      bundleKey,
      authParams: ["mock-llm"],
      bedrockRole: false,
    },
    github: {
      mode: "secret",
      name: "pi-cloud-agents/pi-cloud-agents-core/github/token",
    },
    options: {
      installTimeoutSec: 60,
      trustProjectConfig: true,
      idleGraceSec: 60,
      suspendAfterIdleSec: 300,
      terminateAfterSuspendedSec: 1800,
      autoPush: true,
      maxDurationSec: 7200,
    },
    logGroup: "/aws/lambda/microvms/pi-cloud-agents-runner",
  };

  // 9. Send /run hook if requested (default true)
  if (options.autoRunHook !== false) {
    const rawPayload = encodeLaunchPayload(payload);
    await dispatchRunHook(boundHookPort, {
      microvmId: "microvm-local-01",
      runHookPayload: rawPayload,
    });

    // Wait for provisioning to finish and API server to become ready
    await runner.waitForProvisioning();
    await waitForApiReady(apiPort, 15000);
  }

  const cleanup = async () => {
    await runner.stop();
  };

  return {
    runId,
    baseDir,
    bareRepoDir,
    bareRepoUrl: `file://${bareRepoDir}`,
    workBranch,
    hookPort: boundHookPort,
    apiPort,
    secretToken,
    runner,
    storageSink,
    cleanup,
  };
}

/**
 * Sends POST /aws/lambda-microvms/runtime/v1/run to the hook server.
 */
async function dispatchRunHook(
  port: number,
  body: { microvmId: string; runHookPayload: string },
): Promise<void> {
  const postData = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/aws/lambda-microvms/runtime/v1/run",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let responseData = "";
        res.on("data", (chunk) => {
          responseData += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Run hook failed with status ${res.statusCode}: ${responseData}`));
          }
        });
      },
    );

    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Polls GET /v1/status until the API server responds 200 OK.
 */
async function waitForApiReady(port: number, timeoutMs: number): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/v1/status`, (res) => {
          resolve(res.statusCode ?? 500);
        });
        req.on("error", reject);
        req.setTimeout(1000, () => {
          req.destroy();
          resolve(500);
        });
      });

      if (status === 200) {
        return;
      }
    } catch {
      // API not up yet, retry
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for runner API on port ${port} after ${timeoutMs}ms`);
}

// CLI entrypoint
if (
  process.argv[1] &&
  (process.argv[1].endsWith("run-local.ts") || process.argv[1].endsWith("run-local.js"))
) {
  console.log("Starting local runner harness...");
  startLocalHarness()
    .then((harness) => {
      console.log("Local harness running:");
      console.log(`  Run ID:    ${harness.runId}`);
      console.log(`  Hook Port: ${harness.hookPort}`);
      console.log(`  API Port:  ${harness.apiPort}`);
      console.log(`  Base Dir:  ${harness.baseDir}`);
      console.log("Press Ctrl+C to shut down.");

      const handleExit = async () => {
        console.log("\nShutting down local harness...");
        await harness.cleanup();
        process.exit(0);
      };

      process.on("SIGINT", handleExit);
      process.on("SIGTERM", handleExit);
    })
    .catch((err) => {
      console.error("Failed to start local harness:", err);
      process.exit(1);
    });
}
