/**
 * In-VM MicroVM workspace preparation: git repository clone, branch checkout,
 * credential management (GIT_ASKPASS), install command execution, and start daemons.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { extractTar } from "../core/pi-config.js";
import type { RepoConfig } from "../shared/config.js";
import { type LaunchPayload, ProtocolErrorCode } from "../shared/protocol.js";
import type { Logger } from "./logger.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_WORKSPACE_DIR = "/work/repo";
export const DEFAULT_GIT_USER_NAME = "pi-cloud-agents[bot]";
export const DEFAULT_GIT_USER_EMAIL = "pi-cloud-agents[bot]@users.noreply.github.com";

/**
 * Structured error thrown when the workspace install script times out.
 */
export class InstallTimeoutError extends Error {
  public readonly code = ProtocolErrorCode.INSTALL_TIMEOUT;
  public readonly timeoutSec: number;
  public readonly partialLog: string;

  constructor(timeoutSec: number, partialLog: string) {
    super(`Workspace install script timed out after ${timeoutSec} seconds`);
    this.name = "InstallTimeoutError";
    this.timeoutSec = timeoutSec;
    this.partialLog = partialLog;
  }
}

/**
 * Structured error thrown when the workspace install script exits with a non-zero code.
 */
export class InstallFailedError extends Error {
  public readonly code = ProtocolErrorCode.INTERNAL_ERROR;
  public readonly exitCode: number | null;
  public readonly log: string;

  constructor(exitCode: number | null, log: string) {
    super(`Workspace install script failed with exit code ${exitCode ?? "null"}`);
    this.name = "InstallFailedError";
    this.exitCode = exitCode;
    this.log = log;
  }
}

export interface StartedProcessInfo {
  command: string;
  pid?: number;
  logPath: string;
  process?: ChildProcess;
}

export interface PrepareWorkspaceParams {
  payload: LaunchPayload;
  repoConfig?: RepoConfig;
  gitAskPassPath?: string;
  workingDirectory?: string;
  logger?: Logger;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
}

export interface PrepareWorkspaceResult {
  workingDirectory: string;
  workBranch: string;
  initialCommit?: string;
  installLog?: string;
  startedProcesses: StartedProcessInfo[];
}

/**
 * Creates or ensures a GIT_ASKPASS executable script that securely reads process.env.GITHUB_TOKEN.
 * Never writes the raw token to disk.
 */
export function ensureGitAskPassScript(customPath?: string): string {
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }

  const defaultLocation = "/opt/pi-cloud/askpass.sh";
  if (fs.existsSync(defaultLocation)) {
    return defaultLocation;
  }

  // Generate in a secure temp directory
  const targetDir = path.join(os.tmpdir(), "pi-cloud-askpass");
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const scriptPath = path.join(targetDir, "askpass.sh");

  const scriptContent = [
    "#!/bin/sh",
    "# pi-cloud-agents GIT_ASKPASS credential helper",
    'if [ -n "$GITHUB_TOKEN" ]; then',
    '  exec echo "$GITHUB_TOKEN"',
    'elif [ -n "$GH_TOKEN" ]; then',
    '  exec echo "$GH_TOKEN"',
    "else",
    '  exec echo ""',
    "fi",
    "",
  ].join("\n");

  fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755, encoding: "utf8" });
  fs.chmodSync(scriptPath, 0o755);

  return scriptPath;
}

/**
 * Clones repository, sets up work branch, configures git identity, executes install scripts,
 * and launches background daemons.
 */
export async function prepareWorkspace(
  params: PrepareWorkspaceParams,
): Promise<PrepareWorkspaceResult> {
  const { payload, repoConfig, logger } = params;
  const workingDirectory = params.workingDirectory ?? DEFAULT_WORKSPACE_DIR;
  const effectiveEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...params.env,
  };

  logger?.info?.(
    `Preparing workspace for run '${payload.runId}' at '${workingDirectory}' from '${payload.repo.url}'`,
  );

  // 1. Configure GIT_ASKPASS helper
  const askPassScript = ensureGitAskPassScript(params.gitAskPassPath);
  effectiveEnv.GIT_ASKPASS = askPassScript;
  effectiveEnv.GIT_TERMINAL_PROMPT = "0";

  // 2. Prepare destination directory
  if (fs.existsSync(workingDirectory)) {
    const contents = fs.readdirSync(workingDirectory);
    if (contents.length > 0 && !contents.every((f) => f === ".git")) {
      logger?.warn?.(
        `Working directory '${workingDirectory}' is not empty. Proceeding with clone/checkout.`,
      );
    }
  } else {
    fs.mkdirSync(workingDirectory, { recursive: true });
  }

  // 3. Clone repository
  const isGitRepo =
    fs.existsSync(path.join(workingDirectory, ".git")) &&
    fs.statSync(path.join(workingDirectory, ".git")).isDirectory();

  if (!isGitRepo) {
    const cloneArgs: string[] = ["clone"];

    if (payload.repo.depth && payload.repo.depth > 0) {
      cloneArgs.push("--depth", String(payload.repo.depth));
    }

    if (payload.repo.ref) {
      cloneArgs.push("--branch", payload.repo.ref);
    }

    cloneArgs.push(payload.repo.url, workingDirectory);

    logger?.info?.(`Executing: git ${cloneArgs.join(" ")}`);

    try {
      await execFileAsync("git", cloneArgs, {
        env: effectiveEnv,
        signal: params.abortSignal,
      });
    } catch (err) {
      // If branch clone failed because ref is a commit SHA rather than branch/tag, fallback to full/shallow clone then checkout
      if (payload.repo.ref) {
        logger?.warn?.(
          `git clone --branch ${payload.repo.ref} failed, retrying plain clone + checkout SHA`,
        );
        const fallbackArgs = ["clone", payload.repo.url, workingDirectory];
        if (payload.repo.depth && payload.repo.depth > 0) {
          fallbackArgs.splice(1, 0, "--depth", String(payload.repo.depth));
        }
        await execFileAsync("git", fallbackArgs, {
          env: effectiveEnv,
          signal: params.abortSignal,
        });
        await execFileAsync("git", ["checkout", payload.repo.ref], {
          cwd: workingDirectory,
          env: effectiveEnv,
          signal: params.abortSignal,
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        logger?.error?.(`git clone failed: ${msg}`);
        throw new Error(`Failed to clone repository '${payload.repo.url}': ${msg}`);
      }
    }
  }

  // 4. Create and checkout the workBranch
  const workBranch = payload.repo.workBranch;
  try {
    // Check if branch already exists
    const { stdout: branchList } = await execFileAsync("git", ["branch", "--list", workBranch], {
      cwd: workingDirectory,
      env: effectiveEnv,
      signal: params.abortSignal,
    });

    if (branchList.trim().length > 0) {
      await execFileAsync("git", ["checkout", workBranch], {
        cwd: workingDirectory,
        env: effectiveEnv,
        signal: params.abortSignal,
      });
    } else {
      await execFileAsync("git", ["checkout", "-b", workBranch], {
        cwd: workingDirectory,
        env: effectiveEnv,
        signal: params.abortSignal,
      });
    }
    logger?.info?.(`Checked out work branch '${workBranch}'`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.error?.(`Failed to checkout work branch '${workBranch}': ${msg}`);
    throw new Error(`Failed to checkout work branch '${workBranch}': ${msg}`);
  }

  // 5. Configure git committer identity
  await execFileAsync("git", ["config", "user.name", DEFAULT_GIT_USER_NAME], {
    cwd: workingDirectory,
    env: effectiveEnv,
  });
  await execFileAsync("git", ["config", "user.email", DEFAULT_GIT_USER_EMAIL], {
    cwd: workingDirectory,
    env: effectiveEnv,
  });

  // 6. Security Assertion: Verify no token was written to .git/config
  const gitConfigPath = path.join(workingDirectory, ".git", "config");
  if (fs.existsSync(gitConfigPath)) {
    const gitConfigContent = fs.readFileSync(gitConfigPath, "utf8");
    if (effectiveEnv.GITHUB_TOKEN && gitConfigContent.includes(effectiveEnv.GITHUB_TOKEN)) {
      throw new Error("Security violation: GitHub authentication token was written to .git/config");
    }
    if (gitConfigContent.includes("ghp_") || gitConfigContent.includes("github_pat_")) {
      throw new Error("Security violation: Potential GitHub PAT token detected inside .git/config");
    }
  }

  // Capture initial commit SHA
  let initialCommit: string | undefined;
  try {
    const { stdout: headSha } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: workingDirectory,
      env: effectiveEnv,
    });
    initialCommit = headSha.trim();
  } catch {
    // Initial commit may be empty if blank repo
  }

  // 7. Execute RepoConfig.install if configured
  let installLog: string | undefined;
  const installCmd = repoConfig?.install;
  if (installCmd && installCmd.trim().length > 0) {
    const timeoutSec = payload.options.installTimeoutSec || 300;
    logger?.info?.(`Executing install command with ${timeoutSec}s timeout: ${installCmd}`);

    const installLogPath = path.join(workingDirectory, "install.log");
    const logChunks: string[] = [];

    const installPromise = new Promise<void>((resolve, reject) => {
      const child = spawn("bash", ["-lc", installCmd], {
        cwd: workingDirectory,
        env: {
          ...effectiveEnv,
          ...(repoConfig.env || {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let timeoutTimer: NodeJS.Timeout | null = null;
      if (timeoutSec > 0) {
        timeoutTimer = setTimeout(() => {
          child.kill("SIGKILL");
          const partialLog = logChunks.join("");
          try {
            fs.writeFileSync(installLogPath, partialLog, "utf8");
          } catch {
            // Ignore log write error on timeout
          }
          reject(new InstallTimeoutError(timeoutSec, partialLog));
        }, timeoutSec * 1000);
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        logChunks.push(text);
        logger?.debug?.(text.trimEnd());
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        logChunks.push(text);
        logger?.warn?.(text.trimEnd());
      });

      child.on("error", (err) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        const log = logChunks.join("");
        try {
          fs.writeFileSync(installLogPath, log, "utf8");
        } catch {
          // Ignore
        }
        reject(err);
      });

      child.on("close", (code) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        const log = logChunks.join("");
        try {
          fs.writeFileSync(installLogPath, log, "utf8");
        } catch {
          // Ignore
        }

        if (code === 0) {
          resolve();
        } else {
          reject(new InstallFailedError(code, log));
        }
      });
    });

    try {
      await installPromise;
      installLog = logChunks.join("");
      logger?.info?.("Install command completed successfully");
    } catch (err) {
      if (err instanceof InstallTimeoutError || err instanceof InstallFailedError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new InstallFailedError(1, `Install execution error: ${msg}`);
    }
  }

  // 8. Spawn RepoConfig.start detached commands if configured
  const startedProcesses: StartedProcessInfo[] = [];
  const startCmd = repoConfig?.start;
  if (startCmd && startCmd.trim().length > 0) {
    const daemonLogDir = path.join(workingDirectory, ".pi-cloud-logs");
    fs.mkdirSync(daemonLogDir, { recursive: true });
    const daemonLogFile = path.join(daemonLogDir, "start.log");
    const daemonLogFd = fs.openSync(daemonLogFile, "a");

    logger?.info?.(`Spawning detached start command: ${startCmd}`);

    const child = spawn("bash", ["-lc", startCmd], {
      cwd: workingDirectory,
      env: {
        ...effectiveEnv,
        ...(repoConfig.env || {}),
      },
      detached: true,
      stdio: ["ignore", daemonLogFd, daemonLogFd],
    });

    child.unref();

    startedProcesses.push({
      command: startCmd,
      pid: child.pid,
      logPath: daemonLogFile,
      process: child,
    });
  }

  return {
    workingDirectory,
    workBranch,
    initialCommit,
    installLog,
    startedProcesses,
  };
}

/**
 * Restores a workspace directory from an archive TAR buffer or file.
 * Continuation support for runs exceeding hard time limits (T5.3 interface).
 */
export async function restoreWorkspaceFromArchive(
  archivePathOrBuffer: string | Buffer,
  targetDir: string,
): Promise<string[]> {
  fs.mkdirSync(targetDir, { recursive: true });

  let buffer: Buffer;
  if (typeof archivePathOrBuffer === "string") {
    if (!fs.existsSync(archivePathOrBuffer)) {
      throw new Error(`Archive file not found at '${archivePathOrBuffer}'`);
    }
    buffer = fs.readFileSync(archivePathOrBuffer);
  } else {
    buffer = archivePathOrBuffer;
  }

  return extractTar(buffer, targetDir);
}
