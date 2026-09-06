import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeterministicTar } from "../../core/pi-config.js";
import { createLogger } from "../../runner/logger.js";
import {
  InstallFailedError,
  InstallTimeoutError,
  ensureGitAskPassScript,
  prepareWorkspace,
  restoreWorkspaceFromArchive,
} from "../../runner/workspace.js";
import type { LaunchPayload } from "../../shared/protocol.js";

describe("T2.3 Workspace Preparation", () => {
  let tempBaseDir: string;
  let bareRepoDir: string;
  let workDir: string;
  let dummyToken: string;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cloud-workspace-test-"));
    bareRepoDir = path.join(tempBaseDir, "remote.git");
    workDir = path.join(tempBaseDir, "work-repo");
    dummyToken = "ghp_SECRET_TOKEN_9876543210_XYZ";

    // Initialize bare git repo with a main branch and initial commit
    fs.mkdirSync(bareRepoDir, { recursive: true });
    execSync("git init --bare -b main", { cwd: bareRepoDir, stdio: "ignore" });

    // Create a temporary clone to seed a commit into the bare repo
    const seedDir = path.join(tempBaseDir, "seed-repo");
    fs.mkdirSync(seedDir, { recursive: true });
    execSync("git init -b main", { cwd: seedDir, stdio: "ignore" });
    execSync("git config user.name 'Test Committer'", { cwd: seedDir, stdio: "ignore" });
    execSync("git config user.email 'test@example.com'", { cwd: seedDir, stdio: "ignore" });
    fs.writeFileSync(path.join(seedDir, "README.md"), "# Seed Repository\n");
    execSync("git add README.md", { cwd: seedDir, stdio: "ignore" });
    execSync("git commit -m 'Initial seed commit'", { cwd: seedDir, stdio: "ignore" });
    execSync(`git remote add origin file://${bareRepoDir}`, { cwd: seedDir, stdio: "ignore" });
    execSync("git push origin main", { cwd: seedDir, stdio: "ignore" });
  });

  afterEach(() => {
    if (fs.existsSync(tempBaseDir)) {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    }
  });

  function createTestPayload(overrides?: Partial<LaunchPayload>): LaunchPayload {
    return {
      v: 1,
      runId: "run-20260906-workspace01",
      owner: "ant",
      stack: {
        name: "pi-cloud-agents-test",
        region: "us-east-1",
        bucket: "pi-cloud-test-bucket",
      },
      repo: {
        url: `file://${bareRepoDir}`,
        workBranch: "pi-cloud/run-workspace01",
        ref: "main",
      },
      model: {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
      },
      piConfig: {
        bundleKey: "config/bundle.tar",
        authParams: ["anthropic"],
        bedrockRole: false,
      },
      github: {
        mode: "secret",
        name: "pi-cloud-agents/test/github/token",
      },
      options: {
        installTimeoutSec: 10,
        trustProjectConfig: true,
        idleGraceSec: 60,
        suspendAfterIdleSec: 300,
        terminateAfterSuspendedSec: 600,
        autoPush: true,
        maxDurationSec: 3600,
      },
      logGroup: "/aws/lambda-microvms/pi-cloud-agents-runner",
      ...overrides,
    };
  }

  it("ensures GIT_ASKPASS helper script exists and is executable", () => {
    const askPassPath = ensureGitAskPassScript();
    expect(fs.existsSync(askPassPath)).toBe(true);

    const stat = fs.statSync(askPassPath);
    // Check executable bit
    expect((stat.mode & 0o111) > 0).toBe(true);

    const content = fs.readFileSync(askPassPath, "utf8");
    expect(content).toContain("GITHUB_TOKEN");
  });

  it("clones repository and checks out workBranch with user identity configured", async () => {
    const payload = createTestPayload();
    const logger = createLogger({ level: "debug" });

    const result = await prepareWorkspace({
      payload,
      workingDirectory: workDir,
      logger,
      env: {
        GITHUB_TOKEN: dummyToken,
      },
    });

    expect(result.workingDirectory).toBe(workDir);
    expect(result.workBranch).toBe("pi-cloud/run-workspace01");
    expect(fs.existsSync(path.join(workDir, "README.md"))).toBe(true);

    // Verify current branch is workBranch
    const currentBranch = execSync("git branch --show-current", {
      cwd: workDir,
      encoding: "utf8",
    }).trim();
    expect(currentBranch).toBe("pi-cloud/run-workspace01");

    // Verify user config
    const userName = execSync("git config user.name", { cwd: workDir, encoding: "utf8" }).trim();
    const userEmail = execSync("git config user.email", { cwd: workDir, encoding: "utf8" }).trim();
    expect(userName).toBe("pi-cloud-agents[bot]");
    expect(userEmail).toBe("pi-cloud-agents[bot]@users.noreply.github.com");

    // Verify commit can be made on the work branch
    fs.writeFileSync(path.join(workDir, "test.txt"), "hello workspace");
    execSync("git add test.txt", { cwd: workDir });
    execSync("git commit -m 'Test commit on workBranch'", { cwd: workDir });
    const log = execSync("git log -1 --oneline", { cwd: workDir, encoding: "utf8" });
    expect(log).toContain("Test commit on workBranch");
  });

  it("strictly ensures NO token is written into .git/config or remote url", async () => {
    const payload = createTestPayload();
    await prepareWorkspace({
      payload,
      workingDirectory: workDir,
      env: {
        GITHUB_TOKEN: dummyToken,
      },
    });

    const gitConfigPath = path.join(workDir, ".git", "config");
    expect(fs.existsSync(gitConfigPath)).toBe(true);
    const gitConfig = fs.readFileSync(gitConfigPath, "utf8");

    // Critical security check
    expect(gitConfig).not.toContain(dummyToken);
    expect(gitConfig).not.toContain("ghp_");

    const remoteUrl = execSync("git config --get remote.origin.url", {
      cwd: workDir,
      encoding: "utf8",
    }).trim();
    expect(remoteUrl).not.toContain(dummyToken);
    expect(remoteUrl).not.toContain("@");
  });

  it("executes RepoConfig.install successfully and records install.log", async () => {
    const payload = createTestPayload();
    const result = await prepareWorkspace({
      payload,
      workingDirectory: workDir,
      repoConfig: {
        install: "echo 'Installing packages...' && echo 'Done' > installed.marker",
      },
    });

    expect(fs.existsSync(path.join(workDir, "installed.marker"))).toBe(true);
    expect(fs.readFileSync(path.join(workDir, "installed.marker"), "utf8")).toContain("Done");
    expect(result.installLog).toContain("Installing packages...");

    const installLogOnDisk = fs.readFileSync(path.join(workDir, "install.log"), "utf8");
    expect(installLogOnDisk).toContain("Installing packages...");
  });

  it("handles RepoConfig.install timeout with INSTALL_TIMEOUT error and captures partial log", async () => {
    const payload = createTestPayload({
      options: {
        installTimeoutSec: 1, // 1 second timeout
        trustProjectConfig: true,
        idleGraceSec: 60,
        suspendAfterIdleSec: 300,
        terminateAfterSuspendedSec: 600,
        autoPush: true,
        maxDurationSec: 3600,
      },
    });

    await expect(
      prepareWorkspace({
        payload,
        workingDirectory: workDir,
        repoConfig: {
          install: "echo 'Starting long build...' && sleep 10",
        },
      }),
    ).rejects.toThrow(InstallTimeoutError);

    // Verify install.log captured partial output before timeout
    const installLogOnDisk = fs.readFileSync(path.join(workDir, "install.log"), "utf8");
    expect(installLogOnDisk).toContain("Starting long build...");
  });

  it("handles RepoConfig.install failure with InstallFailedError and captures log", async () => {
    const payload = createTestPayload();

    await expect(
      prepareWorkspace({
        payload,
        workingDirectory: workDir,
        repoConfig: {
          install: "echo 'Fatal failure' >&2 && exit 42",
        },
      }),
    ).rejects.toThrow(InstallFailedError);

    const installLogOnDisk = fs.readFileSync(path.join(workDir, "install.log"), "utf8");
    expect(installLogOnDisk).toContain("Fatal failure");
  });

  it("spawns RepoConfig.start background daemon detached", async () => {
    const payload = createTestPayload();
    const result = await prepareWorkspace({
      payload,
      workingDirectory: workDir,
      repoConfig: {
        start: "echo 'Daemon running' > daemon.out",
      },
    });

    expect(result.startedProcesses.length).toBe(1);
    expect(result.startedProcesses[0]?.command).toContain("daemon.out");

    // Wait a brief moment for daemon command to complete echo
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fs.existsSync(path.join(workDir, "daemon.out"))).toBe(true);
  });

  it("restores workspace from archive buffer (continuation interface)", async () => {
    const restoreDir = path.join(tempBaseDir, "restored-repo");
    const tar = createDeterministicTar([
      { name: "src/app.ts", content: "console.log('Restored App');\n" },
      { name: "package.json", content: '{"name":"restored"}\n' },
    ]);

    const extracted = await restoreWorkspaceFromArchive(tar, restoreDir);
    expect(extracted.length).toBe(2);
    expect(fs.existsSync(path.join(restoreDir, "src/app.ts"))).toBe(true);
    expect(fs.readFileSync(path.join(restoreDir, "src/app.ts"), "utf8")).toContain("Restored App");
  });
});
