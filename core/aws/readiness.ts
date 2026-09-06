/**
 * AWS Account Readiness probe.
 * Checks STS identity, Lambda MicroVM availability, base images, permissions, and service quotas.
 */

import {
  LambdaMicrovmsClient,
  ListManagedMicrovmImageVersionsCommand,
  ListManagedMicrovmImagesCommand,
  ListMicrovmImagesCommand,
  ListMicrovmsCommand,
} from "@aws-sdk/client-lambda-microvms";
import { ListServiceQuotasCommand, ServiceQuotasClient } from "@aws-sdk/client-service-quotas";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { maskAccountId, maskArn } from "./mask.js";

export const SUPPORTED_MICROVM_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "ap-northeast-1",
  "eu-west-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "eu-central-1",
  "eu-north-1",
] as const;

export type SupportedMicrovmRegion = (typeof SUPPORTED_MICROVM_REGIONS)[number];

export function isMicrovmRegionSupported(region: string): boolean {
  return (SUPPORTED_MICROVM_REGIONS as readonly string[]).includes(region);
}

export function getDefaultMemoryQuotaGB(region: string): number {
  if (["us-east-1", "us-east-2", "us-west-2", "ap-northeast-1"].includes(region)) {
    return 1024;
  }
  return 400;
}

export interface AwsReadinessOptions {
  region?: string;
  profile?: string;
  stsClient?: STSClient;
  microvmsClient?: LambdaMicrovmsClient;
  serviceQuotasClient?: ServiceQuotasClient;
}

export interface AwsReadinessReport {
  timestamp: string;
  region: string;
  regionSupported: boolean;
  identity: {
    status: "PASS" | "FAIL";
    account: string;
    arn: string;
    userId?: string;
    error?: string;
  };
  microvmManagedImages: {
    status: "PASS" | "FAIL" | "SKIPPED";
    baseImageArn?: string;
    baseImageVersion?: string;
    availableImages: string[];
    error?: string;
  };
  microvmImages: {
    status: "PASS" | "FAIL" | "SKIPPED";
    imageCount: number;
    error?: string;
  };
  microvms: {
    status: "PASS" | "FAIL" | "SKIPPED";
    microvmCount: number;
    error?: string;
  };
  serviceQuota: {
    status: "PASS" | "FAIL" | "DEFAULT" | "SKIPPED";
    memoryQuotaGB?: number;
    quotaName?: string;
    error?: string;
  };
  verdict: "READY" | "BLOCKED" | "NOT_CONFIGURED";
  remediations: string[];
}

export async function probeAwsReadiness(
  options: AwsReadinessOptions = {},
): Promise<AwsReadinessReport> {
  const region =
    options.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  const timestamp = new Date().toISOString();
  const regionSupported = isMicrovmRegionSupported(region);

  const report: AwsReadinessReport = {
    timestamp,
    region,
    regionSupported,
    identity: {
      status: "FAIL",
      account: "<ACCOUNT_ID>",
      arn: "<UNKNOWN>",
    },
    microvmManagedImages: {
      status: "SKIPPED",
      availableImages: [],
    },
    microvmImages: {
      status: "SKIPPED",
      imageCount: 0,
    },
    microvms: {
      status: "SKIPPED",
      microvmCount: 0,
    },
    serviceQuota: {
      status: "SKIPPED",
    },
    verdict: "BLOCKED",
    remediations: [],
  };

  const clientConfig = {
    region,
    ...(options.profile ? { profile: options.profile } : {}),
  };

  // 1. STS Caller Identity Probe
  const sts = options.stsClient ?? new STSClient(clientConfig);
  try {
    const callerId = await sts.send(new GetCallerIdentityCommand({}));
    report.identity.status = "PASS";
    report.identity.account = callerId.Account ? maskAccountId(callerId.Account) : "<ACCOUNT_ID>";
    report.identity.arn = callerId.Arn ? maskArn(callerId.Arn) : "<UNKNOWN>";
    report.identity.userId = callerId.UserId;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    report.identity.status = "FAIL";
    report.identity.error = maskAccountId(errorMsg);
    report.verdict = "NOT_CONFIGURED";
    report.remediations.push(
      "Configure valid AWS credentials via AWS_PROFILE, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or ~/.aws/credentials.",
    );
    return report;
  }

  if (!regionSupported) {
    report.remediations.push(
      `Region '${region}' is not currently in the Lambda MicroVMs supported region list (${SUPPORTED_MICROVM_REGIONS.join(", ")}).`,
    );
  }

  // 2. MicroVMs API Probes
  const microvmsClient = options.microvmsClient ?? new LambdaMicrovmsClient(clientConfig);

  // 2a. ListManagedMicrovmImages
  try {
    const managedOutput = await microvmsClient.send(new ListManagedMicrovmImagesCommand({}));
    report.microvmManagedImages.status = "PASS";
    const images = (managedOutput.items ?? []).map((img) => img.imageArn || "").filter(Boolean);
    report.microvmManagedImages.availableImages = images;

    if (images.length > 0) {
      report.microvmManagedImages.baseImageArn = images[0];

      // Probe latest active version for the first base image
      try {
        const versionsOutput = await microvmsClient.send(
          new ListManagedMicrovmImageVersionsCommand({
            imageIdentifier: images[0],
          }),
        );
        const versions = versionsOutput.items ?? [];
        const activeVersion = versions.find((v) => v.status === "AVAILABLE") || versions[0];
        if (activeVersion?.imageVersion) {
          report.microvmManagedImages.baseImageVersion = activeVersion.imageVersion;
        }
      } catch (versionErr: unknown) {
        // Non-fatal if version query fails, base image is still detected
        const msg = versionErr instanceof Error ? versionErr.message : String(versionErr);
        report.microvmManagedImages.error = maskAccountId(msg);
      }
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    report.microvmManagedImages.status = "FAIL";
    report.microvmManagedImages.error = maskAccountId(errorMsg);
    report.remediations.push(
      `Ensure IAM principal has 'lambda:ListManagedMicrovmImages' and MicroVMs are enabled in ${region}.`,
    );
  }

  // 2b. ListMicrovmImages (Customer images permission probe)
  try {
    const imagesOutput = await microvmsClient.send(new ListMicrovmImagesCommand({}));
    report.microvmImages.status = "PASS";
    report.microvmImages.imageCount = (imagesOutput.items ?? []).length;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    report.microvmImages.status = "FAIL";
    report.microvmImages.error = maskAccountId(errorMsg);
    report.remediations.push("Ensure IAM principal has 'lambda:ListMicrovmImages' permission.");
  }

  // 2c. ListMicrovms (MicroVM instances permission probe)
  try {
    const vmsOutput = await microvmsClient.send(new ListMicrovmsCommand({}));
    report.microvms.status = "PASS";
    report.microvms.microvmCount = (vmsOutput.items ?? []).length;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    report.microvms.status = "FAIL";
    report.microvms.error = maskAccountId(errorMsg);
    report.remediations.push("Ensure IAM principal has 'lambda:ListMicrovms' permission.");
  }

  // 3. Service Quotas Probe (Best Effort)
  const defaultQuota = getDefaultMemoryQuotaGB(region);
  const sqClient = options.serviceQuotasClient ?? new ServiceQuotasClient(clientConfig);
  try {
    const quotasOutput = await sqClient.send(
      new ListServiceQuotasCommand({
        ServiceCode: "lambda",
      }),
    );
    const quotas = quotasOutput.Quotas ?? [];
    const memoryQuota = quotas.find(
      (q) =>
        q.QuotaName?.toLowerCase().includes("microvm") ||
        q.QuotaName?.toLowerCase().includes("memory"),
    );

    if (memoryQuota?.Value !== undefined) {
      report.serviceQuota.status = "PASS";
      report.serviceQuota.memoryQuotaGB = memoryQuota.Value;
      report.serviceQuota.quotaName = memoryQuota.QuotaName;
    } else {
      report.serviceQuota.status = "DEFAULT";
      report.serviceQuota.memoryQuotaGB = defaultQuota;
      report.serviceQuota.quotaName = `Regional default (${defaultQuota} GB)`;
    }
  } catch (_err: unknown) {
    // Service Quotas access denied or unavailable -> graceful fallback to regional default
    report.serviceQuota.status = "DEFAULT";
    report.serviceQuota.memoryQuotaGB = defaultQuota;
    report.serviceQuota.quotaName = `Regional default (${defaultQuota} GB)`;
  }

  // 4. Overall Verdict Determination
  const isReady =
    report.identity.status === "PASS" &&
    report.regionSupported &&
    report.microvmManagedImages.status === "PASS" &&
    report.microvmImages.status === "PASS" &&
    report.microvms.status === "PASS";

  if (isReady) {
    report.verdict = "READY";
  } else {
    report.verdict = "BLOCKED";
  }

  return report;
}

/**
 * Format the readiness report into a clean, aligned, no-emoji ASCII/Unicode table.
 */
export function formatReadinessTable(report: AwsReadinessReport): string {
  const width = 76;
  const innerWidth = width - 4; // between "│ " and " │"

  const lines: string[] = [];

  const pad = (left: string, right: string, targetWidth: number): string => {
    const totalContentLen = left.length + right.length;
    if (totalContentLen >= targetWidth) {
      return `${left} ${right}`;
    }
    return left + " ".repeat(targetWidth - totalContentLen) + right;
  };

  const headerTitle = ` AWS Readiness Probe · ${report.region} `;
  const topBorderLen = width - 2 - headerTitle.length;
  lines.push(`┌${headerTitle}${"─".repeat(Math.max(0, topBorderLen))}┐`);

  // Row helper
  const addRow = (label: string, value: string, badge: string) => {
    const leftPart = `${label.padEnd(24)} ${value}`;
    const truncatedLeft =
      leftPart.length > innerWidth - badge.length - 1
        ? `${leftPart.slice(0, innerWidth - badge.length - 4)}…`
        : leftPart;
    lines.push(`│ ${pad(truncatedLeft, badge, innerWidth)} │`);
  };

  // Identity
  const identityBadge = report.identity.status === "PASS" ? "✓ PASS" : "✗ FAIL";
  addRow("Caller Identity", report.identity.arn, identityBadge);

  // Region support
  const regionBadge = report.regionSupported ? "✓ PASS" : "▲ WARN";
  const regionVal = report.regionSupported
    ? `MicroVMs supported in ${report.region}`
    : `Region ${report.region} not in verified list`;
  addRow("Region Support", regionVal, regionBadge);

  // Base Image
  let baseImgVal = "None detected";
  if (report.microvmManagedImages.baseImageArn) {
    baseImgVal = report.microvmManagedImages.baseImageArn;
    if (report.microvmManagedImages.baseImageVersion) {
      baseImgVal += ` (${report.microvmManagedImages.baseImageVersion})`;
    }
  } else if (report.microvmManagedImages.status === "SKIPPED") {
    baseImgVal = "Skipped (no credentials)";
  } else if (report.microvmManagedImages.error) {
    baseImgVal = `Error: ${report.microvmManagedImages.error}`;
  }
  const baseImgBadge =
    report.microvmManagedImages.status === "PASS"
      ? "✓ PASS"
      : report.microvmManagedImages.status === "SKIPPED"
        ? "○ SKIP"
        : "✗ FAIL";
  addRow("Managed Base Images", baseImgVal, baseImgBadge);

  // Customer Images
  let custImgVal = `${report.microvmImages.imageCount} image(s)`;
  if (report.microvmImages.status === "SKIPPED") {
    custImgVal = "Skipped (no credentials)";
  } else if (report.microvmImages.error) {
    custImgVal = `Error: ${report.microvmImages.error}`;
  }
  const custImgBadge =
    report.microvmImages.status === "PASS"
      ? "✓ PASS"
      : report.microvmImages.status === "SKIPPED"
        ? "○ SKIP"
        : "✗ FAIL";
  addRow("Customer Images API", custImgVal, custImgBadge);

  // MicroVM Instances
  let vmsVal = `${report.microvms.microvmCount} instance(s)`;
  if (report.microvms.status === "SKIPPED") {
    vmsVal = "Skipped (no credentials)";
  } else if (report.microvms.error) {
    vmsVal = `Error: ${report.microvms.error}`;
  }
  const vmsBadge =
    report.microvms.status === "PASS"
      ? "✓ PASS"
      : report.microvms.status === "SKIPPED"
        ? "○ SKIP"
        : "✗ FAIL";
  addRow("MicroVM Instances API", vmsVal, vmsBadge);

  // Service Quotas
  const quotaVal = `${report.serviceQuota.memoryQuotaGB ?? getDefaultMemoryQuotaGB(report.region)} GB (${report.serviceQuota.quotaName || "default"})`;
  const quotaBadge =
    report.serviceQuota.status === "PASS"
      ? "✓ PASS"
      : report.serviceQuota.status === "DEFAULT"
        ? "· DEFAULT"
        : report.serviceQuota.status === "SKIPPED"
          ? "○ SKIP"
          : "▲ WARN";
  addRow("Service Quota (Memory)", quotaVal, quotaBadge);

  // Divider
  lines.push(`├${"─".repeat(width - 2)}┤`);

  // Verdict line
  let verdictBadge = "● READY";
  if (report.verdict === "BLOCKED") verdictBadge = "▲ BLOCKED";
  if (report.verdict === "NOT_CONFIGURED") verdictBadge = "○ NOT CONFIGURED";
  lines.push(`│ ${pad(`Verdict: ${report.verdict}`, verdictBadge, innerWidth)} │`);

  // Remediations if any
  if (report.remediations.length > 0) {
    lines.push(`│ ${"Remediations / Action items:".padEnd(innerWidth)} │`);
    for (const rem of report.remediations) {
      const bullet = `→ ${rem}`;
      if (bullet.length <= innerWidth) {
        lines.push(`│ ${bullet.padEnd(innerWidth)} │`);
      } else {
        const words = rem.split(" ");
        let currentLine = "→ ";
        for (const w of words) {
          if ((currentLine + w).length > innerWidth - 2) {
            lines.push(`│ ${currentLine.padEnd(innerWidth)} │`);
            currentLine = `  ${w} `;
          } else {
            currentLine += `${w} `;
          }
        }
        if (currentLine.trim()) {
          lines.push(`│ ${currentLine.padEnd(innerWidth)} │`);
        }
      }
    }
  }

  lines.push(`└${"─".repeat(width - 2)}┘`);
  return lines.join("\n");
}
