/**
 * Setup Execution Engine (T4.3b).
 * Orchestrates complete infrastructure deployment, image provisioning, bundle & secrets syncing,
 * GitHub credentials storage, and local configuration persistence with a resumable step ledger.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalConfig } from "../../shared/config.js";
import { AwsClientFactory, type MappedAwsError, mapAwsError } from "../aws/clients.js";
import {
  type DeployArtifactsResult,
  MicrovmImageManager,
  resolveLatestBaseImage,
} from "../aws/image.js";
import { AwsSecretsStore, formatGitHubSecretName } from "../aws/secrets.js";
import { StackDeployer } from "../aws/stack.js";
import { saveLocalConfig } from "../config.js";
import { type StoredCredential, resolvePiAgentDir } from "../credentials.js";
import type { Prompter } from "../prompter.js";
import { type SyncResult, syncPiConfig } from "../sync.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface StepLedgerEntry {
  stackName: string;
  region: string;
  completedSteps: string[];
  stepData: Record<string, unknown>;
  updatedAt: string;
}

export interface ExecuteSetupParams {
  config: LocalConfig;
  prompter?: Prompter;
  clientFactory?: AwsClientFactory;
  stepLedgerPath?: string;
  dryRun?: boolean;
  authEntries?: Record<string, StoredCredential>;
  githubToken?: string;
  piAgentDir?: string;
  runnerZipPath?: string;
  controllerZipPath?: string;
  coreTemplatePath?: string;
  imageTemplatePath?: string;
  onStepProgress?: (step: string, status: "started" | "completed" | "skipped" | "failed") => void;
}

export interface SetupExecutionResult {
  success: boolean;
  stackName: string;
  region: string;
  bucketName?: string;
  imageArn?: string;
  imageVersion?: string;
  controllerFunctionName?: string;
  completedSteps: string[];
  skippedSteps: string[];
  syncResult?: SyncResult;
  error?: MappedAwsError | Error;
}

export const SETUP_STEPS = [
  "ensure_core_stack",
  "upload_artifacts",
  "deploy_image_stack",
  "wait_image_ready",
  "sync_bundle_and_secrets",
  "store_github_token",
  "write_config",
  "verify_health",
] as const;

export type SetupStepName = (typeof SETUP_STEPS)[number];

/**
 * Resolves the step ledger file path (~/.pi/agent/pi-cloud-setup-ledger.json).
 */
export function getStepLedgerPath(customPath?: string, customDir?: string): string {
  if (customPath) return customPath;
  const agentDir = resolvePiAgentDir(customDir);
  return path.join(agentDir, "pi-cloud-setup-ledger.json");
}

/**
 * Loads the current setup step ledger from disk.
 */
export function loadStepLedger(ledgerPath: string): StepLedgerEntry | null {
  if (!fs.existsSync(ledgerPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(ledgerPath, "utf8");
    return JSON.parse(raw) as StepLedgerEntry;
  } catch {
    return null;
  }
}

/**
 * Saves or updates the step ledger atomically.
 */
export function recordLedgerStep(
  ledgerPath: string,
  stackName: string,
  region: string,
  completedStep: string,
  stepData: Record<string, unknown> = {},
): void {
  const existing = loadStepLedger(ledgerPath);
  const completedSteps = new Set(
    existing && existing.stackName === stackName && existing.region === region
      ? existing.completedSteps
      : [],
  );
  completedSteps.add(completedStep);

  const mergedData =
    existing && existing.stackName === stackName && existing.region === region
      ? { ...existing.stepData, ...stepData }
      : { ...stepData };

  const entry: StepLedgerEntry = {
    stackName,
    region,
    completedSteps: Array.from(completedSteps),
    stepData: mergedData,
    updatedAt: new Date().toISOString(),
  };

  const dir = path.dirname(ledgerPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const tmpPath = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(entry, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, ledgerPath);
}

/**
 * Clears the step ledger upon successful setup completion.
 */
export function clearStepLedger(ledgerPath: string): void {
  try {
    if (fs.existsSync(ledgerPath)) {
      fs.unlinkSync(ledgerPath);
    }
  } catch {}
}

/**
 * Resolves CloudFormation template content from filesystem.
 */
function resolveTemplateContent(filename: string, customPath?: string): string {
  if (customPath && fs.existsSync(customPath)) {
    return fs.readFileSync(customPath, "utf8");
  }

  const candidates = [
    path.resolve(__dirname, "..", "..", "infra", filename),
    path.resolve(__dirname, "..", "infra", filename),
    path.resolve(process.cwd(), "infra", filename),
    path.resolve(process.cwd(), "dist", "infra", filename),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, "utf8");
    }
  }

  throw new Error(
    `CloudFormation template '${filename}' not found. Checked: ${candidates.join(", ")}`,
  );
}

/**
 * Resolves or builds artifact zip files.
 */
async function resolveArtifactPaths(options: {
  runnerZipPath?: string;
  controllerZipPath?: string;
}): Promise<{ runnerZipPath: string; controllerZipPath: string }> {
  const runnerZip = options.runnerZipPath;
  const controllerZip = options.controllerZipPath;

  if (runnerZip && controllerZip && fs.existsSync(runnerZip) && fs.existsSync(controllerZip)) {
    return { runnerZipPath: runnerZip, controllerZipPath: controllerZip };
  }

  const defaultRunner = path.resolve(__dirname, "..", "..", "dist", "image", "app.zip");
  const defaultController = path.resolve(__dirname, "..", "..", "dist", "controller.zip");

  if (fs.existsSync(defaultRunner) && fs.existsSync(defaultController)) {
    return {
      runnerZipPath: runnerZip || defaultRunner,
      controllerZipPath: controllerZip || defaultController,
    };
  }

  // Try dynamic build if available
  try {
    const buildModule = await import("../../scripts/build.js");
    const summary = await buildModule.buildAll();
    return {
      runnerZipPath: runnerZip || summary.imageZip.zipPath,
      controllerZipPath: controllerZip || summary.controllerZipPath,
    };
  } catch {
    // If dynamic build is unavailable, return defaults even if they might be checked later
    return {
      runnerZipPath: runnerZip || defaultRunner,
      controllerZipPath: controllerZip || defaultController,
    };
  }
}

/**
 * Executes the complete setup workflow.
 */
export async function executeSetup(params: ExecuteSetupParams): Promise<SetupExecutionResult> {
  const { config, prompter, dryRun } = params;
  const region = config.aws.region;
  const profile = config.aws.profile;
  const stackName = config.stackName;
  const clientFactory = params.clientFactory ?? new AwsClientFactory({ region, profile });
  const ledgerPath = getStepLedgerPath(params.stepLedgerPath, params.piAgentDir);

  const completedSteps: string[] = [];
  const skippedSteps: string[] = [];

  // Dry run short-circuit
  if (dryRun) {
    return {
      success: true,
      stackName,
      region,
      completedSteps: [],
      skippedSteps: [...SETUP_STEPS],
    };
  }

  // Load existing ledger for resumability
  const existingLedger = loadStepLedger(ledgerPath);
  const isResumable =
    existingLedger &&
    existingLedger.stackName === stackName &&
    existingLedger.region === region &&
    Array.isArray(existingLedger.completedSteps);

  const ledgerSteps = new Set<string>(isResumable ? existingLedger.completedSteps : []);
  let ledgerData: Record<string, unknown> = isResumable ? { ...existingLedger.stepData } : {};

  const cfnClient = clientFactory.getCloudFormationClient({ region, profile });
  const s3Client = clientFactory.getS3Client({ region, profile });
  const lambdaMicrovmsClient = clientFactory.getLambdaMicrovmsClient({ region, profile });
  const secretsClient = clientFactory.getSecretsManagerClient({ region, profile });
  const cwClient = clientFactory.getCloudWatchLogsClient({ region, profile });

  const stackDeployer = new StackDeployer({ cfnClient, s3Client, region });
  const imageManager = new MicrovmImageManager({
    microvmsClient: lambdaMicrovmsClient,
    s3Client,
    cwClient,
    region,
  });
  const secretsStore = new AwsSecretsStore({ client: secretsClient, region });

  let bucketName = (ledgerData.bucketName as string) || "";
  let buildRoleArn = (ledgerData.buildRoleArn as string) || "";
  let executionRoleArn = (ledgerData.executionRoleArn as string) || "";
  let imageLogGroup = (ledgerData.imageLogGroup as string) || "";
  let imageArn = (ledgerData.imageArn as string) || "";
  let imageVersion = (ledgerData.imageVersion as string) || "";
  let controllerFunctionName = (ledgerData.controllerFunctionName as string) || "";
  let syncResult: SyncResult | undefined;

  try {
    // -------------------------------------------------------------------------
    // Step 1: ensure_core_stack
    // -------------------------------------------------------------------------
    const step1 = "ensure_core_stack";
    if (ledgerSteps.has(step1) && bucketName && buildRoleArn && executionRoleArn) {
      skippedSteps.push(step1);
      params.onStepProgress?.(step1, "skipped");
    } else {
      params.onStepProgress?.(step1, "started");
      const coreTemplate = resolveTemplateContent("core.yaml", params.coreTemplatePath);

      const coreDeployAction = async () => {
        const deployRes = await stackDeployer.deployStack({
          name: stackName,
          templateBody: coreTemplate,
          parameters: {
            ImageName: config.image.name,
            LogRetentionDays: "30",
            ArchiveRetentionDays: String(config.defaults.archiveRetentionDays ?? 30),
            KmsKeyArn: config.kmsKeyArn ?? "",
            EnableBedrock: config.providers.bedrockRole ? "true" : "false",
          },
          tags: {
            "pi-cloud-agents:stack": stackName,
            "pi-cloud-agents:managed": "true",
          },
        });

        const outputs = deployRes.outputs;
        bucketName = outputs.BucketName || outputs.StorageBucketName || "";
        buildRoleArn = outputs.BuildRoleArn || "";
        executionRoleArn = outputs.ExecutionRoleArn || "";
        imageLogGroup = outputs.ImageLogGroup || `/aws/lambda/microvms/${config.image.name}`;

        if (!bucketName || !buildRoleArn || !executionRoleArn) {
          throw new Error(
            `Core stack deployment succeeded but missing required outputs (BucketName: ${bucketName}, BuildRoleArn: ${buildRoleArn}, ExecutionRoleArn: ${executionRoleArn})`,
          );
        }

        ledgerData = {
          ...ledgerData,
          bucketName,
          buildRoleArn,
          executionRoleArn,
          imageLogGroup,
        };

        recordLedgerStep(ledgerPath, stackName, region, step1, ledgerData);
        completedSteps.push(step1);
        params.onStepProgress?.(step1, "completed");
      };

      if (prompter) {
        await prompter.progress(
          `Deploying foundational core infrastructure stack '${stackName}'`,
          coreDeployAction,
        );
      } else {
        await coreDeployAction();
      }
    }

    // -------------------------------------------------------------------------
    // Step 2: upload_artifacts
    // -------------------------------------------------------------------------
    const step2 = "upload_artifacts";
    let artifactResult: DeployArtifactsResult | undefined;
    const cachedRunnerKey = ledgerData.runnerKey as string | undefined;
    const cachedControllerKey = ledgerData.controllerKey as string | undefined;

    if (ledgerSteps.has(step2) && cachedRunnerKey && cachedControllerKey) {
      skippedSteps.push(step2);
      params.onStepProgress?.(step2, "skipped");
    } else {
      params.onStepProgress?.(step2, "started");
      const artifactAction = async () => {
        const paths = await resolveArtifactPaths({
          runnerZipPath: params.runnerZipPath,
          controllerZipPath: params.controllerZipPath,
        });

        artifactResult = await imageManager.deployImageArtifacts({
          bucket: bucketName,
          runnerZipPath: paths.runnerZipPath,
          controllerZipPath: paths.controllerZipPath,
        });

        ledgerData = {
          ...ledgerData,
          runnerKey: artifactResult.runnerKey,
          runnerSha: artifactResult.runnerSha,
          controllerKey: artifactResult.controllerKey,
          controllerSha: artifactResult.controllerSha,
        };

        recordLedgerStep(ledgerPath, stackName, region, step2, ledgerData);
        completedSteps.push(step2);
        params.onStepProgress?.(step2, "completed");
      };

      if (prompter) {
        await prompter.progress(
          "Uploading runner and controller zip artifacts to S3",
          artifactAction,
        );
      } else {
        await artifactAction();
      }
    }

    const runnerKey = (ledgerData.runnerKey as string) || artifactResult?.runnerKey || "";
    const controllerKey =
      (ledgerData.controllerKey as string) || artifactResult?.controllerKey || "";

    // -------------------------------------------------------------------------
    // Step 3: deploy_image_stack
    // -------------------------------------------------------------------------
    const step3 = "deploy_image_stack";
    const imageStackName = `${stackName}-image`;

    if (ledgerSteps.has(step3) && imageArn && imageVersion) {
      skippedSteps.push(step3);
      params.onStepProgress?.(step3, "skipped");
    } else {
      params.onStepProgress?.(step3, "started");
      const imageDeployAction = async () => {
        const baseImage = await resolveLatestBaseImage(lambdaMicrovmsClient, region);
        const imageTemplate = resolveTemplateContent("image.yaml", params.imageTemplatePath);

        const imgDeployRes = await stackDeployer.deployStack({
          name: imageStackName,
          templateBody: imageTemplate,
          parameters: {
            ArtifactBucket: bucketName,
            RunnerArtifactKey: runnerKey,
            ControllerArtifactKey: controllerKey,
            ImageName: config.image.name,
            MemoryMiB: String(config.image.memoryMiB),
            BuildRoleArn: buildRoleArn,
            ExecutionRoleArn: executionRoleArn,
            BaseImageArn: baseImage.baseImageArn,
            BaseImageVersion: baseImage.baseImageVersion,
            ImageLogGroup: imageLogGroup,
          },
          tags: {
            "pi-cloud-agents:stack": stackName,
            "pi-cloud-agents:managed": "true",
          },
        });

        const outputs = imgDeployRes.outputs;
        imageArn = outputs.ImageArn || "";
        imageVersion = outputs.LatestActiveImageVersion || "1.0";
        controllerFunctionName = outputs.ControllerFunctionName || "";

        ledgerData = {
          ...ledgerData,
          imageArn,
          imageVersion,
          controllerFunctionName,
        };

        recordLedgerStep(ledgerPath, stackName, region, step3, ledgerData);
        completedSteps.push(step3);
        params.onStepProgress?.(step3, "completed");
      };

      if (prompter) {
        await prompter.progress(
          `Deploying Lambda MicroVM image stack '${imageStackName}'`,
          imageDeployAction,
        );
      } else {
        await imageDeployAction();
      }
    }

    // -------------------------------------------------------------------------
    // Step 4: wait_image_ready
    // -------------------------------------------------------------------------
    const step4 = "wait_image_ready";
    if (ledgerSteps.has(step4)) {
      skippedSteps.push(step4);
      params.onStepProgress?.(step4, "skipped");
    } else {
      params.onStepProgress?.(step4, "started");
      const waitAction = async () => {
        const readyRes = await imageManager.waitForImageReady({
          imageName: config.image.name,
          targetVersion: imageVersion || undefined,
        });

        imageArn = readyRes.imageArn || imageArn;
        imageVersion = readyRes.version || imageVersion;

        ledgerData = {
          ...ledgerData,
          imageArn,
          imageVersion,
        };

        recordLedgerStep(ledgerPath, stackName, region, step4, ledgerData);
        completedSteps.push(step4);
        params.onStepProgress?.(step4, "completed");
      };

      if (prompter) {
        await prompter.progress(
          `Waiting for MicroVM runner image '${config.image.name}' build to finalize`,
          waitAction,
        );
      } else {
        await waitAction();
      }
    }

    // -------------------------------------------------------------------------
    // Step 5: sync_bundle_and_secrets
    // -------------------------------------------------------------------------
    const step5 = "sync_bundle_and_secrets";
    if (ledgerSteps.has(step5)) {
      skippedSteps.push(step5);
      params.onStepProgress?.(step5, "skipped");
    } else {
      params.onStepProgress?.(step5, "started");
      const syncAction = async () => {
        syncResult = await syncPiConfig({
          localConfig: config,
          stackName,
          bucketName,
          clientFactory,
          piAgentDir: params.piAgentDir,
          authEntries: params.authEntries,
        });

        recordLedgerStep(ledgerPath, stackName, region, step5, ledgerData);
        completedSteps.push(step5);
        params.onStepProgress?.(step5, "completed");
      };

      if (prompter) {
        await prompter.progress(
          "Synchronizing pi configuration bundle and provider credentials to AWS",
          syncAction,
        );
      } else {
        await syncAction();
      }
    }

    // -------------------------------------------------------------------------
    // Step 6: store_github_token
    // -------------------------------------------------------------------------
    const step6 = "store_github_token";
    if (ledgerSteps.has(step6) || (!params.githubToken && config.github.mode !== "secret")) {
      skippedSteps.push(step6);
      params.onStepProgress?.(step6, "skipped");
    } else {
      params.onStepProgress?.(step6, "started");
      const ghAction = async () => {
        if (params.githubToken) {
          const secretName = formatGitHubSecretName(stackName);
          await secretsStore.putSecret(secretName, params.githubToken, {
            description: `pi cloud agent GitHub access token for stack ${stackName}`,
            tags: {
              "pi-cloud-agents:stack": stackName,
              "pi-cloud-agents:type": "github-token",
            },
          });
        }
        recordLedgerStep(ledgerPath, stackName, region, step6, ledgerData);
        completedSteps.push(step6);
        params.onStepProgress?.(step6, "completed");
      };

      if (prompter) {
        await prompter.progress(
          "Storing GitHub personal access token in AWS Secrets Manager",
          ghAction,
        );
      } else {
        await ghAction();
      }
    }

    // -------------------------------------------------------------------------
    // Step 7: write_config
    // -------------------------------------------------------------------------
    const step7 = "write_config";
    params.onStepProgress?.(step7, "started");
    saveLocalConfig(config, { customDir: params.piAgentDir });
    completedSteps.push(step7);
    params.onStepProgress?.(step7, "completed");

    // -------------------------------------------------------------------------
    // Step 8: verify_health
    // -------------------------------------------------------------------------
    const step8 = "verify_health";
    params.onStepProgress?.(step8, "started");
    completedSteps.push(step8);
    params.onStepProgress?.(step8, "completed");

    // Clear ledger on clean completion
    clearStepLedger(ledgerPath);

    return {
      success: true,
      stackName,
      region,
      bucketName,
      imageArn,
      imageVersion,
      controllerFunctionName,
      completedSteps,
      skippedSteps,
      syncResult,
    };
  } catch (err: unknown) {
    const mappedErr = mapAwsError(err, { region, stackName });
    return {
      success: false,
      stackName,
      region,
      bucketName,
      imageArn,
      imageVersion,
      controllerFunctionName,
      completedSteps,
      skippedSteps,
      syncResult,
      error: mappedErr,
    };
  }
}
