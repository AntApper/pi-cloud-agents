import type { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import type { LambdaMicrovmsClient } from "@aws-sdk/client-lambda-microvms";
import type { S3Client } from "@aws-sdk/client-s3";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { SSMClient } from "@aws-sdk/client-ssm";
import { describe, expect, it, vi } from "vitest";
import { formatCleanupTable, runAwsCleanup } from "../../core/aws/cleanup.js";
import { findForbiddenGlyphs } from "../../scripts/doc-glyph-scan.js";

interface SdkCommandLike {
  constructor?: {
    name?: string;
  };
}

describe("AWS Kill-switch Cleanup", () => {
  it("terminates only test MicroVMs and respects dry-run mode", async () => {
    const terminateMock = vi.fn().mockResolvedValue({});

    const fakeMicrovms = {
      send: async (cmd: SdkCommandLike) => {
        const cmdName = cmd.constructor?.name;
        if (cmdName === "ListMicrovmsCommand") {
          return {
            items: [
              {
                microvmId: "pi-cloud-agents-test-mvm-1",
                state: "RUNNING",
                imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-test",
              },
              {
                microvmId: "pi-cloud-agents-test-mvm-2",
                state: "TERMINATED", // already terminated
                imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-test",
              },
              {
                microvmId: "prod-cloud-agent-mvm", // not a test VM
                state: "RUNNING",
                imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:prod-image",
              },
            ],
          };
        }
        if (cmdName === "TerminateMicrovmCommand") {
          return terminateMock(cmd);
        }
        return {};
      },
    } as unknown as LambdaMicrovmsClient;

    // Dry run
    const dryReport = await runAwsCleanup({
      region: "us-east-1",
      dryRun: true,
      microvmsClient: fakeMicrovms,
    });

    expect(dryReport.summary.microvmsFound).toBe(1);
    expect(dryReport.summary.microvmsTerminated).toBe(1);
    expect(dryReport.resources[0]?.action).toBe("WOULD_TERMINATE");
    expect(terminateMock).not.toHaveBeenCalled();

    const dryFormatted = formatCleanupTable(dryReport);
    expect(dryFormatted).toContain("dry-run");
    expect(dryFormatted).toContain("WOULD_TERMINATE");
    expect(findForbiddenGlyphs(dryFormatted)).toHaveLength(0);

    // Live run
    const liveReport = await runAwsCleanup({
      region: "us-east-1",
      dryRun: false,
      microvmsClient: fakeMicrovms,
    });

    expect(liveReport.summary.microvmsFound).toBe(1);
    expect(liveReport.summary.microvmsTerminated).toBe(1);
    expect(liveReport.resources[0]?.action).toBe("TERMINATED");
    expect(terminateMock).toHaveBeenCalledTimes(1);

    const liveFormatted = formatCleanupTable(liveReport);
    expect(liveFormatted).toContain("live");
    expect(liveFormatted).toContain("TERMINATED");
    expect(findForbiddenGlyphs(liveFormatted)).toHaveLength(0);
  });

  it("cleans up test images, stacks, secrets, params, and buckets on --all", async () => {
    const fakeMicrovms = {
      send: async (cmd: SdkCommandLike) => {
        const cmdName = cmd.constructor?.name;
        if (cmdName === "ListMicrovmsCommand") return { items: [] };
        if (cmdName === "ListMicrovmImagesCommand") {
          return {
            items: [
              {
                name: "pi-cloud-agents-test-img",
                imageArn:
                  "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-test-img",
                state: "CREATED",
              },
              {
                name: "prod-image",
                imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:prod-image",
                state: "CREATED",
              },
            ],
          };
        }
        if (cmdName === "ListMicrovmImageVersionsCommand") return { items: [] };
        if (cmdName === "DeleteMicrovmImageCommand") return {};
        return {};
      },
    } as unknown as LambdaMicrovmsClient;

    const fakeCfn = {
      send: async (cmd: SdkCommandLike) => {
        const cmdName = cmd.constructor?.name;
        if (cmdName === "ListStacksCommand") {
          return {
            StackSummaries: [
              { StackName: "pi-cloud-agents-test-core", StackStatus: "CREATE_COMPLETE" },
              { StackName: "prod-stack", StackStatus: "CREATE_COMPLETE" },
            ],
          };
        }
        if (cmdName === "DeleteStackCommand") return {};
        return {};
      },
    } as unknown as CloudFormationClient;

    const fakeSecrets = {
      send: async (cmd: SdkCommandLike) => {
        const cmdName = cmd.constructor?.name;
        if (cmdName === "ListSecretsCommand") {
          return {
            SecretList: [
              {
                Name: "pi-cloud-agents-test/auth/anthropic",
                ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:pi-cloud-agents-test",
              },
              {
                Name: "production-secret",
                ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod",
              },
            ],
          };
        }
        if (cmdName === "DeleteSecretCommand") return {};
        return {};
      },
    } as unknown as SecretsManagerClient;

    const fakeSsm = {
      send: async (cmd: SdkCommandLike) => {
        const cmdName = cmd.constructor?.name;
        if (cmdName === "DescribeParametersCommand") {
          return {
            Parameters: [{ Name: "/pi-cloud-agents-test/config" }, { Name: "/prod/config" }],
          };
        }
        if (cmdName === "DeleteParameterCommand") return {};
        return {};
      },
    } as unknown as SSMClient;

    const fakeS3 = {
      send: async (cmd: SdkCommandLike) => {
        const cmdName = cmd.constructor?.name;
        if (cmdName === "ListBucketsCommand") {
          return {
            Buckets: [{ Name: "pi-cloud-agents-test-artifacts-1234" }, { Name: "prod-bucket" }],
          };
        }
        if (cmdName === "ListObjectVersionsCommand") return { Versions: [], DeleteMarkers: [] };
        if (cmdName === "DeleteBucketCommand") return {};
        return {};
      },
    } as unknown as S3Client;

    const report = await runAwsCleanup({
      region: "us-east-1",
      all: true,
      dryRun: false,
      microvmsClient: fakeMicrovms,
      cfnClient: fakeCfn,
      secretsClient: fakeSecrets,
      ssmClient: fakeSsm,
      s3Client: fakeS3,
    });

    expect(report.summary.imagesFound).toBe(1);
    expect(report.summary.imagesDeleted).toBe(1);
    expect(report.summary.stacksFound).toBe(1);
    expect(report.summary.stacksDeleted).toBe(1);
    expect(report.summary.secretsFound).toBe(1);
    expect(report.summary.secretsDeleted).toBe(1);
    expect(report.summary.parametersFound).toBe(1);
    expect(report.summary.parametersDeleted).toBe(1);
    expect(report.summary.bucketsFound).toBe(1);
    expect(report.summary.bucketsDeleted).toBe(1);
    expect(report.summary.failedCount).toBe(0);

    const formatted = formatCleanupTable(report);
    expect(formatted).not.toContain("123456789012");
    expect(findForbiddenGlyphs(formatted)).toHaveLength(0);
  });

  it("isolates errors without throwing", async () => {
    const fakeMicrovms = {
      send: async () => {
        throw new Error("AccessDeniedException for account 123456789012");
      },
    } as unknown as LambdaMicrovmsClient;

    const report = await runAwsCleanup({
      region: "us-east-1",
      microvmsClient: fakeMicrovms,
    });

    expect(report.summary.failedCount).toBe(1);
    expect(report.resources[0]?.action).toBe("FAILED");
    expect(report.resources[0]?.error).toContain("<ACCOUNT_ID>");

    const formatted = formatCleanupTable(report);
    expect(formatted).not.toContain("123456789012");
    expect(findForbiddenGlyphs(formatted)).toHaveLength(0);
  });

  it("paginates through all pages for AWS list commands", async () => {
    let vmPage = 0;
    const fakeMicrovms = {
      send: async (cmd: SdkCommandLike) => {
        const cmdName = cmd.constructor?.name;
        if (cmdName === "ListMicrovmsCommand") {
          vmPage++;
          if (vmPage === 1) {
            return {
              items: [
                {
                  microvmId: "pi-cloud-agents-test-mvm-page1",
                  state: "RUNNING",
                  imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-test",
                },
              ],
              nextToken: "page2-token",
            };
          }
          return {
            items: [
              {
                microvmId: "pi-cloud-agents-test-mvm-page2",
                state: "RUNNING",
                imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-test",
              },
            ],
          };
        }
        if (cmdName === "TerminateMicrovmCommand") return {};
        return {};
      },
    } as unknown as LambdaMicrovmsClient;

    const report = await runAwsCleanup({
      region: "us-east-1",
      dryRun: false,
      microvmsClient: fakeMicrovms,
    });

    expect(vmPage).toBe(2);
    expect(report.summary.microvmsFound).toBe(2);
    expect(report.summary.microvmsTerminated).toBe(2);
  });

  describe("S3 test bucket purge", () => {
    const noOtherResources = {
      send: async () => ({}),
    };
    const baseOptions = {
      region: "us-east-1",
      all: true,
      dryRun: false,
      microvmsClient: noOtherResources as unknown as LambdaMicrovmsClient,
      cfnClient: noOtherResources as unknown as CloudFormationClient,
      secretsClient: noOtherResources as unknown as SecretsManagerClient,
      ssmClient: noOtherResources as unknown as SSMClient,
    };

    it("walks every ListObjectVersions page using both markers before deleting the bucket", async () => {
      const seen: Array<{ cmd: string; input: Record<string, unknown> }> = [];
      const fakeS3 = {
        send: async (cmd: SdkCommandLike & { input?: Record<string, unknown> }) => {
          const cmdName = cmd.constructor?.name ?? "";
          seen.push({ cmd: cmdName, input: cmd.input ?? {} });
          if (cmdName === "ListBucketsCommand") {
            return { Buckets: [{ Name: "pi-cloud-agents-test-bucket" }] };
          }
          if (cmdName === "ListObjectVersionsCommand") {
            if (cmd.input?.KeyMarker === undefined) {
              return {
                Versions: [{ Key: "a", VersionId: "1" }],
                DeleteMarkers: [{ Key: "b", VersionId: "2" }],
                IsTruncated: true,
                NextKeyMarker: "b",
                NextVersionIdMarker: "2",
              };
            }
            return { Versions: [{ Key: "c", VersionId: "3" }], IsTruncated: false };
          }
          return {};
        },
      } as unknown as S3Client;

      const report = await runAwsCleanup({ ...baseOptions, s3Client: fakeS3 });

      expect(report.summary.bucketsDeleted).toBe(1);
      expect(report.summary.failedCount).toBe(0);

      const versionCalls = seen.filter((s) => s.cmd === "ListObjectVersionsCommand");
      expect(versionCalls).toHaveLength(2);
      expect(versionCalls[1]?.input).toMatchObject({ KeyMarker: "b", VersionIdMarker: "2" });

      const deletes = seen.filter((s) => s.cmd === "DeleteObjectsCommand");
      expect(deletes).toHaveLength(2);
      expect(seen.filter((s) => s.cmd === "ListObjectsV2Command")).toHaveLength(0);
      expect(seen.at(-1)?.cmd).toBe("DeleteBucketCommand");
    });

    it("falls back to the unversioned sweep only when version listing is denied", async () => {
      const seen: string[] = [];
      const fakeS3 = {
        send: async (cmd: SdkCommandLike) => {
          const cmdName = cmd.constructor?.name ?? "";
          seen.push(cmdName);
          if (cmdName === "ListBucketsCommand") {
            return { Buckets: [{ Name: "pi-cloud-agents-test-bucket" }] };
          }
          if (cmdName === "ListObjectVersionsCommand") {
            const denied = new Error("not allowed to ListBucketVersions");
            denied.name = "AccessDenied";
            throw denied;
          }
          if (cmdName === "ListObjectsV2Command") {
            return { Contents: [{ Key: "a" }], IsTruncated: false };
          }
          return {};
        },
      } as unknown as S3Client;

      const report = await runAwsCleanup({ ...baseOptions, s3Client: fakeS3 });

      expect(report.summary.bucketsDeleted).toBe(1);
      expect(report.summary.failedCount).toBe(0);
      expect(seen).toContain("ListObjectsV2Command");
      expect(seen.at(-1)).toBe("DeleteBucketCommand");
    });

    it("reports the real error instead of masking a throttled version listing with a second sweep", async () => {
      const seen: string[] = [];
      const fakeS3 = {
        send: async (cmd: SdkCommandLike) => {
          const cmdName = cmd.constructor?.name ?? "";
          seen.push(cmdName);
          if (cmdName === "ListBucketsCommand") {
            return { Buckets: [{ Name: "pi-cloud-agents-test-bucket" }] };
          }
          if (cmdName === "ListObjectVersionsCommand") {
            const throttled = new Error("Rate exceeded");
            throttled.name = "SlowDown";
            throw throttled;
          }
          return {};
        },
      } as unknown as S3Client;

      const report = await runAwsCleanup({ ...baseOptions, s3Client: fakeS3 });

      expect(report.summary.bucketsDeleted).toBe(0);
      expect(report.summary.failedCount).toBe(1);
      const bucket = report.resources.find((r) => r.type === "S3_BUCKET");
      expect(bucket?.action).toBe("FAILED");
      expect(bucket?.error).toContain("Rate exceeded");
      expect(seen).not.toContain("ListObjectsV2Command");
      expect(seen).not.toContain("DeleteBucketCommand");
    });
  });
});
