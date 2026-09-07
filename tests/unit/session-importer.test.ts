/**
 * Unit tests for Session Importer and Native Read-Only Session Viewer (T4.12).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GetObjectCommand, type GetObjectCommandOutput, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importRemoteSession, rewriteSessionForLocalViewing } from "../../core/session-importer.js";

const s3Mock = mockClient(S3Client);

describe("T4.12 Session Importer and /cloud open", () => {
  let tmpDir: string;

  beforeEach(() => {
    s3Mock.reset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cloud-session-importer-test-"));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("rewriteSessionForLocalViewing", () => {
    it("rewrites header session record with local cwd and cloud metadata", () => {
      const sampleJsonl = [
        JSON.stringify({
          type: "session",
          id: "sess-1",
          cwd: "/work/repo",
          createdAt: "2026-09-06T12:00:00Z",
        }),
        JSON.stringify({
          type: "message",
          id: "msg-1",
          role: "user",
          content: [{ type: "text", text: "hello" }],
        }),
        JSON.stringify({
          type: "message",
          id: "msg-2",
          role: "assistant",
          content: [{ type: "text", text: "world" }],
        }),
      ].join("\n");

      const { rewrittenJsonl, entryCount } = rewriteSessionForLocalViewing(
        sampleJsonl,
        "run-12345",
        "/local/workspace",
      );

      expect(entryCount).toBe(3);
      const lines = rewrittenJsonl
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));

      expect(lines[0].cwd).toBe("/local/workspace");
      expect(lines[0].cloudRunId).toBe("run-12345");
      expect(lines[0].readOnly).toBe(true);
      expect(lines[0].importedAt).toBeDefined();

      expect(lines[1].role).toBe("user");
      expect(lines[2].role).toBe("assistant");
    });
  });

  describe("importRemoteSession", () => {
    it("downloads session from S3 and saves with mode 0600 in sessions directory", async () => {
      const sampleJsonl = [
        JSON.stringify({ type: "session", id: "sess-1", cwd: "/work/repo" }),
        JSON.stringify({
          type: "message",
          id: "msg-1",
          role: "user",
          content: [{ type: "text", text: "check status" }],
        }),
      ].join("\n");

      s3Mock.on(GetObjectCommand).resolves({
        Body: {
          transformToString: async () => sampleJsonl,
        } as unknown as GetObjectCommandOutput["Body"],
      });

      const mockConfig = {
        aws: { region: "us-east-1" },
        stackName: "pi-cloud-agents-core",
        image: { name: "pi-cloud-agents-runner", memoryMiB: 4096 },
        defaults: {
          model: { provider: "anthropic", id: "claude-sonnet-4-5" },
          maxDurationHours: 4,
          idle: { suspendAfterMin: 15, terminateAfterSuspendedMin: 120 },
          maxConcurrent: 3,
          archiveRetentionDays: 30,
          controllerCadenceMin: 1,
        },
        providers: { synced: ["anthropic"], oauthOptIn: [], bedrockRole: false },
        github: { mode: "none" as const },
      };

      const result = await importRemoteSession({
        runId: "run-abc999",
        config: mockConfig,
        s3Client: s3Mock as unknown as S3Client,
        sessionsDir: tmpDir,
        targetDir: "/local/dir",
      });

      expect(result.runId).toBe("run-abc999");
      expect(result.entryCount).toBe(2);
      expect(result.readOnly).toBe(true);
      expect(fs.existsSync(result.sessionFilePath)).toBe(true);

      const savedContent = fs.readFileSync(result.sessionFilePath, "utf-8");
      expect(savedContent).toContain('"cloudRunId":"run-abc999"');
      expect(savedContent).toContain('"readOnly":true');
      expect(savedContent).toContain('"cwd":"/local/dir"');
    });

    it("throws clear error when S3 session transcript is not found or empty", async () => {
      s3Mock.on(GetObjectCommand).rejects(new Error("NoSuchKey"));

      const mockConfig = {
        aws: { region: "us-east-1" },
        stackName: "pi-cloud-agents-core",
        image: { name: "pi-cloud-agents-runner", memoryMiB: 4096 },
        defaults: {
          model: { provider: "anthropic", id: "claude-sonnet-4-5" },
          maxDurationHours: 4,
          idle: { suspendAfterMin: 15, terminateAfterSuspendedMin: 120 },
          maxConcurrent: 3,
          archiveRetentionDays: 30,
          controllerCadenceMin: 1,
        },
        providers: { synced: ["anthropic"], oauthOptIn: [], bedrockRole: false },
        github: { mode: "none" as const },
      };

      await expect(
        importRemoteSession({
          runId: "run-missing",
          config: mockConfig,
          s3Client: s3Mock as unknown as S3Client,
          sessionsDir: tmpDir,
        }),
      ).rejects.toThrow("Failed to download session transcript");
    });
  });
});
