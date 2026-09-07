/**
 * AWS Kill-switch cleanup engine.
 * Scans and cleans test resources (MicroVMs, images, CloudFormation stacks, Secrets Manager secrets, SSM parameters, S3 buckets)
 * prefixed with 'pi-cloud-agents-test'.
 */

import {
  CloudFormationClient,
  DeleteStackCommand,
  ListStacksCommand,
  type StackSummary,
} from "@aws-sdk/client-cloudformation";
import {
  DeleteMicrovmImageCommand,
  DeleteMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ListMicrovmImageVersionsCommand,
  ListMicrovmImagesCommand,
  ListMicrovmsCommand,
  type MicrovmImageSummary,
  type MicrovmItem,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  type ListObjectVersionsCommandOutput,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DeleteSecretCommand,
  ListSecretsCommand,
  type SecretListEntry,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  DeleteParameterCommand,
  DescribeParametersCommand,
  type ParameterMetadata,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { maskAccountId, maskArn } from "./mask.js";
import { collectPages, iteratePages } from "./paginate.js";

export const TEST_RESOURCE_PREFIX = "pi-cloud-agents-test";

/**
 * Error names for which `ListObjectVersions` is treated as unavailable, so the bucket purge falls
 * back to a plain `ListObjectsV2` sweep. Anything else (throttling, network, NoSuchBucket) is a
 * real failure and is surfaced instead of being masked by a second, weaker sweep.
 */
const VERSION_LISTING_UNAVAILABLE = new Set([
  "AccessDenied",
  "NotImplemented",
  "MethodNotAllowed",
  "UnsupportedOperation",
]);

const S3_PURGE_MAX_PAGES = 1000;

export interface CleanupOptions {
  region?: string;
  profile?: string;
  dryRun?: boolean;
  all?: boolean;
  microvmsClient?: LambdaMicrovmsClient;
  cfnClient?: CloudFormationClient;
  secretsClient?: SecretsManagerClient;
  ssmClient?: SSMClient;
  s3Client?: S3Client;
}

export interface CleanedResource {
  type: "MICROVM" | "IMAGE" | "IMAGE_VERSION" | "STACK" | "SECRET" | "PARAMETER" | "S3_BUCKET";
  id: string;
  name: string;
  state?: string;
  action: "TERMINATED" | "DELETED" | "WOULD_TERMINATE" | "WOULD_DELETE" | "FAILED" | "SKIPPED";
  error?: string;
}

export interface CleanupReport {
  timestamp: string;
  region: string;
  dryRun: boolean;
  all: boolean;
  resources: CleanedResource[];
  summary: {
    microvmsFound: number;
    microvmsTerminated: number;
    imagesFound: number;
    imagesDeleted: number;
    stacksFound: number;
    stacksDeleted: number;
    secretsFound: number;
    secretsDeleted: number;
    parametersFound: number;
    parametersDeleted: number;
    bucketsFound: number;
    bucketsDeleted: number;
    failedCount: number;
  };
}

export async function runAwsCleanup(options: CleanupOptions = {}): Promise<CleanupReport> {
  const region =
    options.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  const dryRun = options.dryRun ?? false;
  const all = options.all ?? false;

  const clientConfig = {
    region,
    ...(options.profile ? { profile: options.profile } : {}),
  };

  const microvmsClient = options.microvmsClient ?? new LambdaMicrovmsClient(clientConfig);
  const cfnClient = options.cfnClient ?? new CloudFormationClient(clientConfig);
  const secretsClient = options.secretsClient ?? new SecretsManagerClient(clientConfig);
  const ssmClient = options.ssmClient ?? new SSMClient(clientConfig);
  const s3Client = options.s3Client ?? new S3Client(clientConfig);

  const report: CleanupReport = {
    timestamp: new Date().toISOString(),
    region,
    dryRun,
    all,
    resources: [],
    summary: {
      microvmsFound: 0,
      microvmsTerminated: 0,
      imagesFound: 0,
      imagesDeleted: 0,
      stacksFound: 0,
      stacksDeleted: 0,
      secretsFound: 0,
      secretsDeleted: 0,
      parametersFound: 0,
      parametersDeleted: 0,
      bucketsFound: 0,
      bucketsDeleted: 0,
      failedCount: 0,
    },
  };

  // 1. Scan and Terminate Test MicroVMs
  try {
    const vms: MicrovmItem[] = await collectPages({
      fetchPage: (nextToken: string | undefined) =>
        microvmsClient.send(new ListMicrovmsCommand({ nextToken })),
      nextToken: (page) => page.nextToken,
      items: (page) => page.items,
    });

    for (const vm of vms) {
      const vmId = vm.microvmId || "";
      const imgArn = vm.imageArn || "";
      const isTestVm =
        vmId.startsWith(TEST_RESOURCE_PREFIX) || imgArn.includes(TEST_RESOURCE_PREFIX);

      if (isTestVm && vm.state !== "TERMINATED") {
        report.summary.microvmsFound++;
        const resource: CleanedResource = {
          type: "MICROVM",
          id: vmId,
          name: vmId,
          state: vm.state,
          action: dryRun ? "WOULD_TERMINATE" : "TERMINATED",
        };

        if (!dryRun) {
          try {
            await microvmsClient.send(new TerminateMicrovmCommand({ microvmIdentifier: vmId }));
            report.summary.microvmsTerminated++;
          } catch (err: unknown) {
            resource.action = "FAILED";
            resource.error = maskAccountId(err instanceof Error ? err.message : String(err));
            report.summary.failedCount++;
          }
        } else {
          report.summary.microvmsTerminated++;
        }
        report.resources.push(resource);
      }
    }
  } catch (err: unknown) {
    // If listing MicroVMs fails (e.g. no creds or permission), record a failed entry
    report.resources.push({
      type: "MICROVM",
      id: "all",
      name: "ListMicrovms",
      action: "FAILED",
      error: maskAccountId(err instanceof Error ? err.message : String(err)),
    });
    report.summary.failedCount++;
  }

  // If `--all` flag is passed, clean up test images, CloudFormation stacks, secrets, SSM params, and S3 buckets
  if (all) {
    // 2a. Clean Test MicroVM Images
    try {
      const images: MicrovmImageSummary[] = await collectPages({
        fetchPage: (nextToken: string | undefined) =>
          microvmsClient.send(new ListMicrovmImagesCommand({ nextToken })),
        nextToken: (page) => page.nextToken,
        items: (page) => page.items,
      });

      for (const img of images) {
        const imgName = img.name || "";
        const imgArn = img.imageArn || "";
        if (imgName.startsWith(TEST_RESOURCE_PREFIX) || imgArn.includes(TEST_RESOURCE_PREFIX)) {
          report.summary.imagesFound++;
          const resource: CleanedResource = {
            type: "IMAGE",
            id: maskArn(imgArn),
            name: imgName,
            state: img.state,
            action: dryRun ? "WOULD_DELETE" : "DELETED",
          };

          if (!dryRun) {
            try {
              // First attempt to delete versions
              try {
                const versions = await collectPages({
                  fetchPage: (nextToken: string | undefined) =>
                    microvmsClient.send(
                      new ListMicrovmImageVersionsCommand({ imageIdentifier: imgArn, nextToken }),
                    ),
                  nextToken: (page) => page.nextToken,
                  items: (page) => page.items,
                });
                for (const ver of versions) {
                  if (ver.imageVersion) {
                    await microvmsClient.send(
                      new DeleteMicrovmImageVersionCommand({
                        imageIdentifier: imgArn,
                        imageVersion: ver.imageVersion,
                      }),
                    );
                  }
                }
              } catch (_verErr) {
                // Ignore version listing errors and proceed to image deletion
              }

              await microvmsClient.send(new DeleteMicrovmImageCommand({ imageIdentifier: imgArn }));
              report.summary.imagesDeleted++;
            } catch (err: unknown) {
              resource.action = "FAILED";
              resource.error = maskAccountId(err instanceof Error ? err.message : String(err));
              report.summary.failedCount++;
            }
          } else {
            report.summary.imagesDeleted++;
          }
          report.resources.push(resource);
        }
      }
    } catch (err: unknown) {
      report.resources.push({
        type: "IMAGE",
        id: "all",
        name: "ListMicrovmImages",
        action: "FAILED",
        error: maskAccountId(err instanceof Error ? err.message : String(err)),
      });
      report.summary.failedCount++;
    }

    // 2b. Clean Test CloudFormation Stacks
    try {
      const stacks: StackSummary[] = await collectPages({
        fetchPage: (NextToken: string | undefined) =>
          cfnClient.send(
            new ListStacksCommand({
              NextToken,
              StackStatusFilter: [
                "CREATE_IN_PROGRESS",
                "CREATE_FAILED",
                "CREATE_COMPLETE",
                "ROLLBACK_IN_PROGRESS",
                "ROLLBACK_FAILED",
                "ROLLBACK_COMPLETE",
                "UPDATE_IN_PROGRESS",
                "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
                "UPDATE_COMPLETE",
                "UPDATE_FAILED",
                "UPDATE_ROLLBACK_IN_PROGRESS",
                "UPDATE_ROLLBACK_FAILED",
                "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
                "UPDATE_ROLLBACK_COMPLETE",
                "REVIEW_IN_PROGRESS",
                "IMPORT_IN_PROGRESS",
                "IMPORT_COMPLETE",
                "IMPORT_ROLLBACK_IN_PROGRESS",
                "IMPORT_ROLLBACK_FAILED",
                "IMPORT_ROLLBACK_COMPLETE",
              ],
            }),
          ),
        nextToken: (page) => page.NextToken,
        items: (page) => page.StackSummaries,
      });

      for (const stack of stacks) {
        const stackName = stack.StackName || "";
        if (stackName.startsWith(TEST_RESOURCE_PREFIX)) {
          report.summary.stacksFound++;
          const resource: CleanedResource = {
            type: "STACK",
            id: maskArn(stack.StackId || stackName),
            name: stackName,
            state: stack.StackStatus,
            action: dryRun ? "WOULD_DELETE" : "DELETED",
          };

          if (!dryRun) {
            try {
              await cfnClient.send(new DeleteStackCommand({ StackName: stackName }));
              report.summary.stacksDeleted++;
            } catch (err: unknown) {
              resource.action = "FAILED";
              resource.error = maskAccountId(err instanceof Error ? err.message : String(err));
              report.summary.failedCount++;
            }
          } else {
            report.summary.stacksDeleted++;
          }
          report.resources.push(resource);
        }
      }
    } catch (err: unknown) {
      report.resources.push({
        type: "STACK",
        id: "all",
        name: "ListStacks",
        action: "FAILED",
        error: maskAccountId(err instanceof Error ? err.message : String(err)),
      });
      report.summary.failedCount++;
    }

    // 2c. Clean Test Secrets Manager Secrets
    try {
      const secrets: SecretListEntry[] = await collectPages({
        fetchPage: (NextToken: string | undefined) =>
          secretsClient.send(new ListSecretsCommand({ NextToken })),
        nextToken: (page) => page.NextToken,
        items: (page) => page.SecretList,
      });

      for (const sec of secrets) {
        const secName = sec.Name || "";
        const isTestSecret =
          secName.startsWith(TEST_RESOURCE_PREFIX) ||
          secName.startsWith(`pi-cloud-agents/${TEST_RESOURCE_PREFIX}`);

        if (isTestSecret) {
          report.summary.secretsFound++;
          const resource: CleanedResource = {
            type: "SECRET",
            id: maskArn(sec.ARN || secName),
            name: secName,
            action: dryRun ? "WOULD_DELETE" : "DELETED",
          };

          if (!dryRun) {
            try {
              await secretsClient.send(
                new DeleteSecretCommand({
                  SecretId: sec.ARN || secName,
                  ForceDeleteWithoutRecovery: true,
                }),
              );
              report.summary.secretsDeleted++;
            } catch (err: unknown) {
              resource.action = "FAILED";
              resource.error = maskAccountId(err instanceof Error ? err.message : String(err));
              report.summary.failedCount++;
            }
          } else {
            report.summary.secretsDeleted++;
          }
          report.resources.push(resource);
        }
      }
    } catch (err: unknown) {
      report.resources.push({
        type: "SECRET",
        id: "all",
        name: "ListSecrets",
        action: "FAILED",
        error: maskAccountId(err instanceof Error ? err.message : String(err)),
      });
      report.summary.failedCount++;
    }

    // 2d. Clean Test SSM Parameters
    try {
      const params: ParameterMetadata[] = await collectPages({
        fetchPage: (NextToken: string | undefined) =>
          ssmClient.send(new DescribeParametersCommand({ NextToken })),
        nextToken: (page) => page.NextToken,
        items: (page) => page.Parameters,
      });

      for (const param of params) {
        const paramName = param.Name || "";
        const isTestParam =
          paramName.startsWith(TEST_RESOURCE_PREFIX) ||
          paramName.startsWith(`/${TEST_RESOURCE_PREFIX}`);

        if (isTestParam) {
          report.summary.parametersFound++;
          const resource: CleanedResource = {
            type: "PARAMETER",
            id: paramName,
            name: paramName,
            action: dryRun ? "WOULD_DELETE" : "DELETED",
          };

          if (!dryRun) {
            try {
              await ssmClient.send(new DeleteParameterCommand({ Name: paramName }));
              report.summary.parametersDeleted++;
            } catch (err: unknown) {
              resource.action = "FAILED";
              resource.error = maskAccountId(err instanceof Error ? err.message : String(err));
              report.summary.failedCount++;
            }
          } else {
            report.summary.parametersDeleted++;
          }
          report.resources.push(resource);
        }
      }
    } catch (err: unknown) {
      report.resources.push({
        type: "PARAMETER",
        id: "all",
        name: "DescribeParameters",
        action: "FAILED",
        error: maskAccountId(err instanceof Error ? err.message : String(err)),
      });
      report.summary.failedCount++;
    }

    // 2e. Clean Test S3 Buckets
    try {
      const buckets = await collectPages({
        fetchPage: (ContinuationToken: string | undefined) =>
          s3Client.send(new ListBucketsCommand({ ContinuationToken })),
        nextToken: (page) => page.ContinuationToken,
        items: (page) => page.Buckets,
      });

      for (const bucket of buckets) {
        const bucketName = bucket.Name || "";
        if (bucketName.startsWith(TEST_RESOURCE_PREFIX)) {
          report.summary.bucketsFound++;
          const resource: CleanedResource = {
            type: "S3_BUCKET",
            id: bucketName,
            name: bucketName,
            action: dryRun ? "WOULD_DELETE" : "DELETED",
          };

          if (!dryRun) {
            try {
              // Empty objects & delete bucket
              await emptyAndDeleteS3Bucket(s3Client, bucketName);
              report.summary.bucketsDeleted++;
            } catch (err: unknown) {
              resource.action = "FAILED";
              resource.error = maskAccountId(err instanceof Error ? err.message : String(err));
              report.summary.failedCount++;
            }
          } else {
            report.summary.bucketsDeleted++;
          }
          report.resources.push(resource);
        }
      }
    } catch (err: unknown) {
      report.resources.push({
        type: "S3_BUCKET",
        id: "all",
        name: "ListBuckets",
        action: "FAILED",
        error: maskAccountId(err instanceof Error ? err.message : String(err)),
      });
      report.summary.failedCount++;
    }
  }

  return report;
}

interface VersionMarker {
  keyMarker?: string;
  versionIdMarker?: string;
}

async function emptyAndDeleteS3Bucket(s3Client: S3Client, bucketName: string): Promise<void> {
  try {
    const versionPages = iteratePages<ListObjectVersionsCommandOutput, VersionMarker>(
      {
        fetchPage: (marker) =>
          s3Client.send(
            new ListObjectVersionsCommand({
              Bucket: bucketName,
              KeyMarker: marker?.keyMarker,
              VersionIdMarker: marker?.versionIdMarker,
            }),
          ),
        nextToken: (page) =>
          page.IsTruncated
            ? { keyMarker: page.NextKeyMarker, versionIdMarker: page.NextVersionIdMarker }
            : undefined,
      },
      { maxPages: S3_PURGE_MAX_PAGES },
    );

    for await (const versions of versionPages) {
      const objectsToDelete = [
        ...(versions.Versions ?? []).map((v) => ({ Key: v.Key!, VersionId: v.VersionId })),
        ...(versions.DeleteMarkers ?? []).map((d) => ({ Key: d.Key!, VersionId: d.VersionId })),
      ];
      if (objectsToDelete.length > 0) {
        await s3Client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: objectsToDelete },
          }),
        );
      }
    }
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : "";
    if (!VERSION_LISTING_UNAVAILABLE.has(name)) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Purging object versions from bucket '${bucketName}' failed: ${message}`, {
        cause: err,
      });
    }

    const objectPages = iteratePages(
      {
        fetchPage: (ContinuationToken: string | undefined) =>
          s3Client.send(new ListObjectsV2Command({ Bucket: bucketName, ContinuationToken })),
        nextToken: (page) => (page.IsTruncated ? page.NextContinuationToken : undefined),
      },
      { maxPages: S3_PURGE_MAX_PAGES },
    );

    for await (const list of objectPages) {
      const keys = (list.Contents ?? []).map((c) => ({ Key: c.Key! }));
      if (keys.length > 0) {
        await s3Client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: keys },
          }),
        );
      }
    }
  }

  await s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
}

/**
 * Format the cleanup report into a clean, aligned, no-emoji ASCII/Unicode table.
 */
export function formatCleanupTable(report: CleanupReport): string {
  const width = 76;
  const innerWidth = width - 4;
  const lines: string[] = [];

  const pad = (left: string, right: string, targetWidth: number): string => {
    const totalContentLen = left.length + right.length;
    if (totalContentLen >= targetWidth) {
      return `${left} ${right}`;
    }
    return left + " ".repeat(targetWidth - totalContentLen) + right;
  };

  const mode = report.dryRun ? "dry-run" : "live";
  const scope = report.all ? "all test resources" : "MicroVMs only";
  const headerTitle = ` AWS Cleanup Kill-switch · ${report.region} (${mode}) `;
  const topBorderLen = width - 2 - headerTitle.length;
  lines.push(`┌${headerTitle}${"─".repeat(Math.max(0, topBorderLen))}┐`);

  lines.push(`│ ${pad(`Scope: ${scope}`, `Prefix: ${TEST_RESOURCE_PREFIX}*`, innerWidth)} │`);
  lines.push(`├${"─".repeat(width - 2)}┤`);

  if (report.resources.length === 0) {
    lines.push(`│ ${"No matching test resources found.".padEnd(innerWidth)} │`);
  } else {
    for (const res of report.resources) {
      let badge = "✓ OK";
      if (res.action === "WOULD_TERMINATE" || res.action === "WOULD_DELETE") badge = "○ PLAN";
      if (res.action === "FAILED") badge = "▲ FAIL";

      const typeLabel = res.type.padEnd(12);
      const namePart = res.name.length > 38 ? `${res.name.slice(0, 35)}…` : res.name;
      const leftPart = `${typeLabel} ${namePart}`;
      const actionPart = `${res.action} ${badge}`;

      lines.push(`│ ${pad(leftPart, actionPart, innerWidth)} │`);
      if (res.error) {
        lines.push(
          `│   ${`Error: ${res.error}`.slice(0, innerWidth - 2).padEnd(innerWidth - 2)} │`,
        );
      }
    }
  }

  lines.push(`├${"─".repeat(width - 2)}┤`);

  // Summary counts
  const totalFound =
    report.summary.microvmsFound +
    report.summary.imagesFound +
    report.summary.stacksFound +
    report.summary.secretsFound +
    report.summary.parametersFound +
    report.summary.bucketsFound;

  const totalActed =
    report.summary.microvmsTerminated +
    report.summary.imagesDeleted +
    report.summary.stacksDeleted +
    report.summary.secretsDeleted +
    report.summary.parametersDeleted +
    report.summary.bucketsDeleted;

  const summaryLeft = `Total found: ${totalFound} · Actions: ${totalActed}`;
  const summaryRight =
    report.summary.failedCount > 0 ? `Failures: ${report.summary.failedCount} ▲` : "✓ Clean";

  lines.push(`│ ${pad(summaryLeft, summaryRight, innerWidth)} │`);
  lines.push(`└${"─".repeat(width - 2)}┘`);

  return lines.join("\n");
}
