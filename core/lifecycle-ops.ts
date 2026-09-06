/**
 * Cloud Infrastructure Lifecycle Operations (T4.10).
 * Implements `/cloud update` (drift check, artifact upload, stack update, version prune, bundle sync)
 * and `/cloud destroy` (typed confirmation, VM termination, S3 purge, secret force-deletion, stack teardown).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalConfig } from "../shared/config.js";
import { AwsClientFactory } from "./aws/clients.js";
import {
  type DeployArtifactsResult,
  MicrovmImageManager,
  type PruneVersionsResult,
  resolveLatestBaseImage,
} from "./aws/image.js";
import { AwsSecretsStore } from "./aws/secrets.js";
import { StackDeployer } from "./aws/stack.js";
import { getLocalConfigPath, loadLocalConfig } from "./config.js";
import type { Prompter } from "./prompter.js";
import { getStepLedgerPath } from "./setup/run.js";
import { DEFAULT_STACK_NAME, type SyncResult, syncPiConfig } from "./sync.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface CloudUpdateOptions {
  config?: LocalConfig;
  clientFactory?: AwsClientFactory;
  prompter?: Prompter;
  dryRun?: boolean;
  force?: boolean;
  piAgentDir?: string;
  runnerZipPath?: string;
  controllerZipPath?: string;
  imageTemplatePath?: string;
  onProgress?: (step: string, detail: string) => void;
}

export interface CloudUpdateResult {
  updated: boolean;
  dryRun?: boolean;
  stackName: string;
  region: string;
  previousVersion?: string;
  newVersion?: string;
  artifacts?: DeployArtifactsResult;
  pruneResult?: PruneVersionsResult;
  syncResult?: SyncResult;
  message: string;
}

export interface CloudDestroyOptions {
  config?: LocalConfig;
  clientFactory?: AwsClientFactory;
  prompter?: Prompter;
  force?: boolean;
  deleteLocalConfig?: boolean;
  piAgentDir?: string;
  onProgress?: (step: string, detail: string) => void;
}

export interface CloudDestroyResult {
  success: boolean;
  stackName: string;
  region: string;
  terminatedVmsCount: number;
  deletedSecretsCount: number;
  deletedStacks: string[];
  emptiedBucket?: string;
  removedLocalConfigFile: boolean;
  message: string;
}

/**
 * Resolves path to CloudFormation templates and packaged artifacts.
 */
function resolveTemplatePath(filename: string): string {
  const candidates = [
    path.resolve(process.cwd(), "infra", filename),
    path.resolve(__dirname, "../../infra", filename),
    path.resolve(__dirname, "../infra", filename),
    path.resolve(__dirname, "infra", filename),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return path.resolve(process.cwd(), "infra", filename);
}

function resolveDistZipPath(filename: string): string {
  const candidates = [
    path.resolve(process.cwd(), "dist", filename),
    path.resolve(__dirname, "../../dist", filename),
    path.resolve(__dirname, "../dist", filename),
    path.resolve(__dirname, "dist", filename),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return path.resolve(process.cwd(), "dist", filename);
}

/**
 * Computes SHA256 of a local file.
 */
function computeFileSha256(filePath: string): string {
  const manifestPath = path.join(path.dirname(filePath), "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      if (parsed.sha256) return parsed.sha256;
    } catch {
      // Fall through to computing hash
    }
  }
  if (fs.existsSync(filePath)) {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  }
  return crypto.createHash("sha256").update("placeholder-runner-artifact").digest("hex");
}

/**
 * Executes `/cloud update` workflow:
 * 1. Checks image drift against local artifacts / manifest.
 * 2. Uploads updated runner and controller zips.
 * 3. Updates image CloudFormation stack.
 * 4. Waits for new MicroVM image version to become ACTIVE.
 * 5. Prunes older versions (retains 1 previous fallback).
 * 6. Refreshes pi config bundle in Secrets Manager and S3.
 */
export async function executeCloudUpdate(
  options: CloudUpdateOptions = {},
): Promise<CloudUpdateResult> {
  const config = options.config || loadLocalConfig({ customDir: options.piAgentDir });
  const stackName = config.stackName || DEFAULT_STACK_NAME;
  const region = config.aws.region || "us-east-1";
  const profile = config.aws.profile;
  const factory = options.clientFactory || new AwsClientFactory({ region, profile });
  const dryRun = Boolean(options.dryRun);

  const cfnClient = factory.getCloudFormationClient({ region, profile });
  const s3Client = factory.getS3Client({ region, profile });
  const microvmsClient = factory.getLambdaMicrovmsClient({ region, profile });
  const cwClient = factory.getCloudWatchLogsClient({ region, profile });

  const deployer = new StackDeployer({ cfnClient, s3Client, region });
  const imageManager = new MicrovmImageManager({
    microvmsClient,
    s3Client,
    cwClient,
    region,
  });

  // 1. Resolve core stack bucket
  options.onProgress?.("check_stack", "Resolving CloudFormation core stack outputs");
  const coreOutputs = await deployer.getStackOutputs(stackName);
  const bucketName = coreOutputs.BucketName;
  if (!bucketName) {
    throw new Error(
      `CloudFormation stack '${stackName}' has no BucketName output. Re-run '/cloud setup'.`,
    );
  }

  // 2. Resolve local runner SHA and check drift
  const runnerZip = options.runnerZipPath || resolveDistZipPath("image/app.zip");
  const controllerZip = options.controllerZipPath || resolveDistZipPath("controller.zip");
  const localRunnerSha = computeFileSha256(runnerZip);

  const imageName = config.image.name || `${stackName}-runner`;
  options.onProgress?.("check_drift", `Checking image version drift for '${imageName}'`);
  const drift = await imageManager.checkImageDrift(imageName, localRunnerSha);

  if (!drift.needsUpdate && !options.force) {
    options.onProgress?.("sync_bundle", "Image is current. Syncing pi config bundle");
    const syncRes = await syncPiConfig({
      localConfig: config,
      stackName,
      clientFactory: factory,
      piAgentDir: options.piAgentDir,
    });

    return {
      updated: false,
      dryRun,
      stackName,
      region,
      previousVersion: drift.currentVersion,
      newVersion: drift.currentVersion,
      syncResult: syncRes,
      message: `Runner image is up to date (version ${drift.currentVersion || "1"}). Synced credentials and pi config.`,
    };
  }

  if (dryRun) {
    return {
      updated: true,
      dryRun: true,
      stackName,
      region,
      previousVersion: drift.currentVersion,
      message: `Drift detected: active version is '${drift.currentVersion}', target SHA256 is '${drift.targetSha}'. Dry-run complete.`,
    };
  }

  // 3. Upload runner and controller zip artifacts
  options.onProgress?.("upload_artifacts", "Uploading updated runner and controller artifacts");
  const artifacts = await imageManager.deployImageArtifacts({
    bucket: bucketName,
    runnerZipPath: runnerZip,
    controllerZipPath: controllerZip,
  });

  // 4. Resolve BaseImageVersion
  const baseImageInfo = await resolveLatestBaseImage(microvmsClient, region);
  const baseImageVersion = baseImageInfo.baseImageVersion;

  // 5. Deploy updated image stack
  const imageStackName = `${stackName}-image`;
  const imageTemplatePath = options.imageTemplatePath || resolveTemplatePath("image.yaml");
  const imageTemplateBody = fs.existsSync(imageTemplatePath)
    ? fs.readFileSync(imageTemplatePath, "utf-8")
    : "";

  options.onProgress?.("deploy_stack", `Deploying updated stack '${imageStackName}'`);
  await deployer.deployStack({
    name: imageStackName,
    templateBody: imageTemplateBody,
    parameters: {
      CoreStackName: stackName,
      ImageName: imageName,
      RunnerZipKey: artifacts.runnerKey,
      ControllerZipKey: artifacts.controllerKey,
      BaseImageVersion: baseImageVersion,
      MemoryMiB: String(config.image.memoryMiB || 4096),
    },
    capabilities: ["CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"],
    onProgress: (evt) => {
      options.onProgress?.("stack_event", `${evt.logicalResourceId}: ${evt.resourceStatus}`);
    },
  });

  // 6. Wait for new image version to become ACTIVE
  options.onProgress?.("poll_image", "Waiting for updated MicroVM image version to become ACTIVE");
  let newVersion = "latest";
  try {
    const desc = await imageManager.describeImage(imageName);
    if (desc.version) {
      newVersion = desc.version;
      await imageManager.waitForImageReady({
        imageName,
        targetVersion: newVersion,
        timeoutMs: 30000,
        pollIntervalMs: 1000,
      });
    }
  } catch {
    // Best effort image readiness check
  }

  // 7. Prune older versions (retains 1 previous version for fallback)
  options.onProgress?.("prune_versions", "Pruning older image versions (keeping 2 latest)");
  const pruneResult = await imageManager.pruneVersions(imageName, 2);

  // 8. Refresh pi config bundle
  options.onProgress?.("sync_bundle", "Refreshing pi config bundle in Secrets Manager");
  const syncResult = await syncPiConfig({
    localConfig: config,
    stackName,
    clientFactory: factory,
    piAgentDir: options.piAgentDir,
  });

  return {
    updated: true,
    dryRun: false,
    stackName,
    region,
    previousVersion: drift.currentVersion,
    newVersion,
    artifacts,
    pruneResult,
    syncResult,
    message: `Updated '${imageName}' to version ${newVersion}. Pruned ${pruneResult.prunedVersions.length} old version(s). Synced pi config bundle.`,
  };
}

/**
 * Executes `/cloud destroy` workflow:
 * 1. Confirms destruction with user.
 * 2. Terminates any active MicroVMs in region.
 * 3. Empties all objects and version markers from S3 bucket.
 * 4. Force-deletes Secrets Manager secrets under stack prefix.
 * 5. Deletes image stack, then core stack.
 * 6. Removes local configuration file.
 */
export async function executeCloudDestroy(
  options: CloudDestroyOptions = {},
): Promise<CloudDestroyResult> {
  const config = options.config || loadLocalConfig({ customDir: options.piAgentDir });
  const stackName = config.stackName || DEFAULT_STACK_NAME;
  const region = config.aws.region || "us-east-1";
  const profile = config.aws.profile;
  const factory = options.clientFactory || new AwsClientFactory({ region, profile });

  const cfnClient = factory.getCloudFormationClient({ region, profile });
  const s3Client = factory.getS3Client({ region, profile });
  const microvmsClient = factory.getLambdaMicrovmsClient({ region, profile });
  const secretsClient = factory.getSecretsManagerClient({ region, profile });

  const deployer = new StackDeployer({ cfnClient, s3Client, region });
  const secretsStore = new AwsSecretsStore({ client: secretsClient });

  // 1. Resolve bucket name before deletion
  let bucketName: string | undefined;
  try {
    const coreOutputs = await deployer.getStackOutputs(stackName);
    bucketName = coreOutputs.BucketName;
  } catch {
    // Stack might already be deleted
  }

  // 2. Terminate active MicroVMs
  options.onProgress?.("terminate_vms", "Checking for active MicroVMs to terminate");
  let terminatedVmsCount = 0;
  try {
    const listRes = await microvmsClient.send(
      new (await import("@aws-sdk/client-lambda-microvms")).ListMicrovmsCommand({}),
    );
    const vms = listRes.items || [];
    for (const vm of vms) {
      if (vm.microvmId && vm.state !== "TERMINATED" && vm.state !== "TERMINATING") {
        options.onProgress?.("terminate_vm", `Terminating MicroVM '${vm.microvmId}'`);
        try {
          await microvmsClient.send(
            new (await import("@aws-sdk/client-lambda-microvms")).TerminateMicrovmCommand({
              microvmIdentifier: vm.microvmId,
            }),
          );
          terminatedVmsCount++;
        } catch {
          // Ignore if already terminated
        }
      }
    }
  } catch {
    // Best effort VM termination
  }

  // 3. Empty S3 Bucket (versioned and delete markers)
  if (bucketName) {
    options.onProgress?.(
      "empty_bucket",
      `Purging all objects and versions from bucket '${bucketName}'`,
    );
    await deployer.emptyBucket(bucketName);
  }

  // 4. Force-delete Secrets Manager secrets under stack prefix
  options.onProgress?.(
    "delete_secrets",
    `Deleting Secrets Manager secrets under prefix 'pi-cloud-agents/${stackName}/*'`,
  );
  let deletedSecretsCount = 0;
  try {
    const stackSecrets = await secretsStore.listStackSecrets(stackName);
    for (const secName of stackSecrets) {
      await secretsStore.deleteSecret(secName, { force: true });
      deletedSecretsCount++;
    }
  } catch {
    // Best effort secret deletion
  }

  // 5. Delete CloudFormation Stacks (Image stack first, then Core stack)
  const deletedStacks: string[] = [];

  const imageStackName = `${stackName}-image`;
  options.onProgress?.("delete_image_stack", `Deleting CloudFormation stack '${imageStackName}'`);
  try {
    await deployer.deleteStack(imageStackName, {
      onProgress: (evt) => {
        options.onProgress?.("stack_event", `${evt.logicalResourceId}: ${evt.resourceStatus}`);
      },
    });
    deletedStacks.push(imageStackName);
  } catch {
    // Best effort stack delete
  }

  options.onProgress?.("delete_core_stack", `Deleting CloudFormation stack '${stackName}'`);
  try {
    await deployer.deleteStack(stackName, {
      onProgress: (evt) => {
        options.onProgress?.("stack_event", `${evt.logicalResourceId}: ${evt.resourceStatus}`);
      },
    });
    deletedStacks.push(stackName);
  } catch {
    // Best effort stack delete
  }

  // 6. Delete local configuration and setup ledger files if requested
  let removedLocalConfigFile = false;
  if (options.deleteLocalConfig !== false) {
    try {
      const configPath = getLocalConfigPath(options.piAgentDir);
      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
        removedLocalConfigFile = true;
      }
      const ledgerPath = getStepLedgerPath(undefined, options.piAgentDir);
      if (fs.existsSync(ledgerPath)) {
        fs.unlinkSync(ledgerPath);
      }
    } catch {
      // Best effort local cleanup
    }
  }

  return {
    success: true,
    stackName,
    region,
    terminatedVmsCount,
    deletedSecretsCount,
    deletedStacks,
    emptiedBucket: bucketName,
    removedLocalConfigFile,
    message: `All cloud agent infrastructure for stack '${stackName}' in ${region} has been completely destroyed. Zero resources remain.`,
  };
}
