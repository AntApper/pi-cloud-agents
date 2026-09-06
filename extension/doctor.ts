/**
 * /cloud doctor diagnostic engine.
 * Probes configuration validity, AWS caller identity, region support,
 * CloudFormation stack states, image drift, pi version, synced providers, and concurrency.
 */

import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { LambdaMicrovmsClient } from "@aws-sdk/client-lambda-microvms";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { MicrovmImageManager } from "../core/aws/image.js";
import { maskAccountId, maskArn } from "../core/aws/mask.js";
import { PINNED_PI_VERSION } from "../core/aws/pi-headless.js";
import { isMicrovmRegionSupported } from "../core/aws/readiness.js";
import { ConfigError, getLocalConfigPath, loadLocalConfig } from "./config.js";

export interface DoctorCheckResult {
  id: string;
  name: string;
  status: "PASS" | "FAIL" | "WARN" | "SKIP";
  detail: string;
  remediation?: string;
}

export interface DoctorReport {
  timestamp: string;
  configPath: string;
  checks: DoctorCheckResult[];
  verdict: "HEALTHY" | "DEGRADED" | "BROKEN";
}

export interface DoctorProbeOptions {
  configDir?: string;
  region?: string;
  profile?: string;
  customClients?: {
    stsClient?: STSClient;
    cfnClient?: CloudFormationClient;
    microvmsClient?: LambdaMicrovmsClient;
  };
}

/**
 * Runs all doctor diagnostic probes.
 */
export async function runDoctorDiagnostics(
  options: DoctorProbeOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorCheckResult[] = [];
  const configPath = getLocalConfigPath(options.configDir);

  // 1. Config Check
  let config: import("../shared/config.js").LocalConfig | undefined;
  try {
    config = loadLocalConfig({ customDir: options.configDir, fallbackToDefault: false });
    checks.push({
      id: "config",
      name: "Configuration File",
      status: "PASS",
      detail: `Valid at ${configPath}`,
    });
  } catch (err) {
    if (err instanceof ConfigError && err.message.includes("not found")) {
      checks.push({
        id: "config",
        name: "Configuration File",
        status: "WARN",
        detail: "Not configured (run /cloud setup to initialize)",
        remediation:
          "Run '/cloud setup' or 'npx pi-cloud-agents setup' to create initial configuration.",
      });
    } else {
      checks.push({
        id: "config",
        name: "Configuration File",
        status: "FAIL",
        detail: err instanceof Error ? err.message : String(err),
        remediation: "Fix JSON syntax or schema errors in ~/.pi/agent/pi-cloud-agents.json.",
      });
    }
    // Fallback to default for remaining checks
    try {
      config = loadLocalConfig({ customDir: options.configDir, fallbackToDefault: true });
    } catch {
      config = undefined;
    }
  }

  const targetRegion =
    options.region || config?.aws.region || process.env.AWS_REGION || "us-east-1";
  const targetProfile = options.profile || config?.aws.profile;
  const clientOpts = {
    region: targetRegion,
    ...(targetProfile ? { profile: targetProfile } : {}),
  };

  // 2. AWS Caller Identity Check
  const sts = options.customClients?.stsClient || new STSClient(clientOpts);
  let callerArn = "<UNKNOWN>";
  try {
    const callerId = await sts.send(new GetCallerIdentityCommand({}));
    callerArn = callerId.Arn ? maskArn(callerId.Arn) : "<AUTHENTICATED>";
    checks.push({
      id: "aws_identity",
      name: "AWS Identity",
      status: "PASS",
      detail: callerArn,
    });
  } catch (err) {
    checks.push({
      id: "aws_identity",
      name: "AWS Identity",
      status: "FAIL",
      detail: maskAccountId(err instanceof Error ? err.message : String(err)),
      remediation: "Ensure AWS credentials are configured via AWS_PROFILE or ~/.aws/credentials.",
    });
  }

  // 3. Region Support Check
  const isRegionSupported = isMicrovmRegionSupported(targetRegion);
  checks.push({
    id: "region_support",
    name: "Region Support",
    status: isRegionSupported ? "PASS" : "WARN",
    detail: `${targetRegion} (${isRegionSupported ? "MicroVMs available" : "MicroVMs not in verified list"})`,
    remediation: isRegionSupported
      ? undefined
      : "Switch region to us-east-1, us-east-2, or us-west-2.",
  });

  // 4. CloudFormation Core Stack Check
  const cfn = options.customClients?.cfnClient || new CloudFormationClient(clientOpts);
  const coreStackName = config?.stackName || "pi-cloud-agents-core";
  try {
    const stacksRes = await cfn.send(new DescribeStacksCommand({ StackName: coreStackName }));
    const stack = stacksRes.Stacks?.[0];
    const status = stack?.StackStatus || "UNKNOWN";
    const isOk = status === "CREATE_COMPLETE" || status === "UPDATE_COMPLETE";
    checks.push({
      id: "core_stack",
      name: "Core Stack",
      status: isOk ? "PASS" : "WARN",
      detail: `${coreStackName} (${status})`,
      remediation: isOk ? undefined : "Deploy or update stack using '/cloud setup'.",
    });
  } catch (err: unknown) {
    const msg = (err as Error)?.message || "";
    const isMissing = /does not exist/i.test(msg);
    checks.push({
      id: "core_stack",
      name: "Core Stack",
      status: isMissing ? "WARN" : "FAIL",
      detail: isMissing ? "Stack not yet deployed" : maskAccountId(msg),
      remediation: "Run '/cloud setup' to create the CloudFormation infrastructure.",
    });
  }

  // 5. Image & Drift Check
  const microvms = options.customClients?.microvmsClient || new LambdaMicrovmsClient(clientOpts);
  const imageName = config?.image.name || "pi-cloud-agents-runner";
  try {
    const imageManager = new MicrovmImageManager({
      microvmsClient: microvms,
      region: targetRegion,
    });
    const imgDesc = await imageManager.describeImage(imageName);
    const activeVersion = imgDesc.version;
    if (activeVersion) {
      checks.push({
        id: "image_status",
        name: "Runner Image",
        status: "PASS",
        detail: `${imageName} (v${activeVersion}, ${imgDesc.status || "ACTIVE"})`,
      });
    } else {
      checks.push({
        id: "image_status",
        name: "Runner Image",
        status: "WARN",
        detail: `${imageName} (no active image version)`,
        remediation: "Deploy runner image via '/cloud setup' or '/cloud update'.",
      });
    }
  } catch (err: unknown) {
    const name = (err as Error)?.name || "";
    const msg = (err as Error)?.message || "";
    const isNotFound =
      name === "ResourceNotFoundException" ||
      /not\s*found|ResourceNotFound|does not exist/i.test(msg) ||
      /not\s*found|ResourceNotFound/i.test(name);
    checks.push({
      id: "image_status",
      name: "Runner Image",
      status: isNotFound ? "WARN" : "FAIL",
      detail: isNotFound ? "Image not found" : maskAccountId(msg),
      remediation: "Build image with '/cloud setup'.",
    });
  }

  // 6. Pi Version Check
  checks.push({
    id: "pi_version",
    name: "pi Target Version",
    status: "PASS",
    detail: `Pinned ${PINNED_PI_VERSION}`,
  });

  // 7. Synced Providers
  const syncedProviders = config?.providers.synced || [];
  checks.push({
    id: "synced_providers",
    name: "Synced Providers",
    status: syncedProviders.length > 0 ? "PASS" : "WARN",
    detail: syncedProviders.length > 0 ? syncedProviders.join(", ") : "None configured",
    remediation:
      syncedProviders.length === 0
        ? "Run '/cloud sync' to sync local provider API keys."
        : undefined,
  });

  // 8. Max Concurrency
  const maxConcurrent = config?.defaults.maxConcurrent ?? 3;
  checks.push({
    id: "concurrency",
    name: "Max Concurrency",
    status: "PASS",
    detail: `${maxConcurrent} concurrent run(s)`,
  });

  // Determine overall verdict
  const hasFail = checks.some((c) => c.status === "FAIL");
  const hasWarn = checks.some((c) => c.status === "WARN");
  const verdict = hasFail ? "BROKEN" : hasWarn ? "DEGRADED" : "HEALTHY";

  return {
    timestamp: new Date().toISOString(),
    configPath,
    checks,
    verdict,
  };
}

/**
 * Formats doctor report into a clean Unicode diagnostic table (no emoji).
 */
export function formatDoctorTable(report: DoctorReport): string {
  const width = 76;
  const innerWidth = width - 4;

  const lines: string[] = [];
  const headerTitle = " pi cloud agents · Doctor Diagnostics ";
  const topDashes = Math.max(0, width - 2 - headerTitle.length);

  lines.push(`┌${headerTitle}${"─".repeat(topDashes)}┐`);

  const statusBadge = (st: DoctorCheckResult["status"]) => {
    switch (st) {
      case "PASS":
        return "✓ PASS";
      case "FAIL":
        return "✗ FAIL";
      case "WARN":
        return "▲ WARN";
      case "SKIP":
        return "○ SKIP";
    }
  };

  const pad = (left: string, right: string, targetWidth: number): string => {
    const totalContentLen = left.length + right.length;
    if (totalContentLen >= targetWidth) {
      return `${left} ${right}`;
    }
    return left + " ".repeat(targetWidth - totalContentLen) + right;
  };

  for (const check of report.checks) {
    const badge = statusBadge(check.status);
    const leftPart = `${check.name.padEnd(20)} ${check.detail}`;
    const truncated =
      leftPart.length > innerWidth - badge.length - 1
        ? `${leftPart.slice(0, innerWidth - badge.length - 4)}…`
        : leftPart;
    lines.push(`│ ${pad(truncated, badge, innerWidth)} │`);
  }

  lines.push(`├${"─".repeat(width - 2)}┤`);

  let verdictBadge = "● HEALTHY";
  if (report.verdict === "DEGRADED") verdictBadge = "▲ DEGRADED";
  if (report.verdict === "BROKEN") verdictBadge = "✗ BROKEN";
  lines.push(`│ ${pad(`Verdict: ${report.verdict}`, verdictBadge, innerWidth)} │`);

  // Remediations if any
  const remediations = report.checks.filter((c) => c.remediation).map((c) => c.remediation!);
  if (remediations.length > 0) {
    lines.push(`├ Remediations ${"─".repeat(Math.max(0, width - 2 - 16))}┤`);
    for (const rem of remediations) {
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
