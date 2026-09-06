import {
  type Capability,
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  type StackEvent,
} from "@aws-sdk/client-cloudformation";
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  NoSuchBucket,
  S3Client,
} from "@aws-sdk/client-s3";

export interface StackEventInfo {
  eventId: string;
  logicalResourceId: string;
  resourceType: string;
  resourceStatus: string;
  resourceStatusReason?: string;
  timestamp: Date;
}

export interface DeployStackParams {
  name: string;
  templateBody: string;
  parameters?: Record<string, string>;
  tags?: Record<string, string>;
  capabilities?: string[];
  onProgress?: (event: StackEventInfo) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface DeleteStackParams {
  name: string;
  onProgress?: (event: StackEventInfo) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export class StackDeployError extends Error {
  readonly stackName: string;
  readonly status: string;
  readonly failureReasons: string[];

  constructor(
    message: string,
    options: {
      stackName: string;
      status?: string;
      failureReasons?: string[];
    },
  ) {
    super(message);
    this.name = "StackDeployError";
    this.stackName = options.stackName;
    this.status = options.status ?? "FAILED";
    this.failureReasons = options.failureReasons ?? [];
  }
}

export interface StackDeployerOptions {
  cfnClient?: CloudFormationClient;
  s3Client?: S3Client;
  region?: string;
}

const IN_PROGRESS_STATUSES = new Set([
  "CREATE_IN_PROGRESS",
  "UPDATE_IN_PROGRESS",
  "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
  "REVIEW_IN_PROGRESS",
]);

const FAILURE_STATUSES = new Set([
  "CREATE_FAILED",
  "ROLLBACK_IN_PROGRESS",
  "ROLLBACK_FAILED",
  "ROLLBACK_COMPLETE",
  "UPDATE_ROLLBACK_IN_PROGRESS",
  "UPDATE_ROLLBACK_FAILED",
  "UPDATE_ROLLBACK_COMPLETE",
  "DELETE_FAILED",
]);

/**
 * CloudFormation stack deployer managing change set creation, execution,
 * progress streaming, rollback diagnostics, and stack destruction.
 */
export class StackDeployer {
  private readonly cfnClient: CloudFormationClient;
  private readonly s3Client: S3Client;

  constructor(options: StackDeployerOptions = {}) {
    const region = options.region ?? process.env.AWS_REGION ?? "us-east-1";
    this.cfnClient = options.cfnClient ?? new CloudFormationClient({ region });
    this.s3Client = options.s3Client ?? new S3Client({ region });
  }

  /**
   * Deploys a CloudFormation template using Change Sets.
   * Handles CREATE vs UPDATE, NO_CHANGES no-op, event streaming, and failure diagnostics.
   */
  async deployStack(
    params: DeployStackParams,
  ): Promise<{ status: string; outputs: Record<string, string> }> {
    const pollInterval = params.pollIntervalMs ?? 2000;
    const timeoutMs = params.timeoutMs ?? 30 * 60 * 1000;
    const deadline = Date.now() + timeoutMs;

    // 1. Determine whether to CREATE or UPDATE
    const existing = await this.describeStack(params.name);
    const isUpdate = existing !== undefined && existing.StackStatus !== "DELETE_COMPLETE";
    const changeSetType = isUpdate ? "UPDATE" : "CREATE";

    const changeSetName = `cs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const cfnParameters = params.parameters
      ? Object.entries(params.parameters).map(([ParameterKey, ParameterValue]) => ({
          ParameterKey,
          ParameterValue,
        }))
      : undefined;

    const cfnTags = params.tags
      ? Object.entries(params.tags).map(([Key, Value]) => ({ Key, Value }))
      : undefined;

    const capabilities: Capability[] = (params.capabilities ?? [
      "CAPABILITY_IAM",
      "CAPABILITY_NAMED_IAM",
      "CAPABILITY_AUTO_EXPAND",
    ]) as Capability[];

    // 2. Create Change Set
    await this.cfnClient.send(
      new CreateChangeSetCommand({
        StackName: params.name,
        ChangeSetName: changeSetName,
        ChangeSetType: changeSetType,
        TemplateBody: params.templateBody,
        Parameters: cfnParameters,
        Tags: cfnTags,
        Capabilities: capabilities,
      }),
    );

    // 3. Poll Change Set creation
    let changeSetReady = false;
    while (!changeSetReady) {
      if (Date.now() > deadline) {
        throw new StackDeployError(
          `Timed out waiting for change set '${changeSetName}' on stack '${params.name}'`,
          { stackName: params.name },
        );
      }

      const csDesc = await this.cfnClient.send(
        new DescribeChangeSetCommand({
          StackName: params.name,
          ChangeSetName: changeSetName,
        }),
      );

      const csStatus = csDesc.Status;

      if (csStatus === "CREATE_COMPLETE") {
        changeSetReady = true;
      } else if (csStatus === "FAILED") {
        const reason = csDesc.StatusReason ?? "";
        // Check if change set failed due to no changes
        if (
          /didn't contain changes|no updates are to be performed|the submitted information/i.test(
            reason,
          )
        ) {
          // Clean up empty change set
          await this.safeDeleteChangeSet(params.name, changeSetName);
          const outputs = await this.getStackOutputs(params.name);
          return { status: "NO_CHANGES", outputs };
        }

        // Real failure: clean up change set and throw
        await this.safeDeleteChangeSet(params.name, changeSetName);
        throw new StackDeployError(
          `Change set creation failed for stack '${params.name}': ${reason}`,
          { stackName: params.name, status: "CHANGE_SET_FAILED" },
        );
      } else {
        await this.sleep(pollInterval);
      }
    }

    // 4. Execute Change Set
    await this.cfnClient.send(
      new ExecuteChangeSetCommand({
        StackName: params.name,
        ChangeSetName: changeSetName,
      }),
    );

    // 5. Stream stack events and wait for stack stabilization
    const seenEventIds = new Set<string>();
    const failureEvents: StackEventInfo[] = [];

    while (Date.now() <= deadline) {
      // Poll events
      await this.pollAndStreamEvents(params.name, seenEventIds, params.onProgress, failureEvents);

      const stackDesc = await this.describeStack(params.name);
      const currentStatus = stackDesc?.StackStatus ?? "UNKNOWN";

      if (currentStatus === "CREATE_COMPLETE" || currentStatus === "UPDATE_COMPLETE") {
        const outputs = this.extractOutputs(stackDesc?.Outputs);
        return { status: currentStatus, outputs };
      }

      if (FAILURE_STATUSES.has(currentStatus)) {
        // Collect failure diagnostics
        await this.pollAndStreamEvents(params.name, seenEventIds, params.onProgress, failureEvents);

        const reasons = failureEvents
          .map(
            (e) =>
              `${e.logicalResourceId} (${e.resourceType}): ${e.resourceStatusReason || e.resourceStatus}`,
          )
          .filter(Boolean);

        const detail = reasons.length > 0 ? reasons.join("; ") : currentStatus;

        throw new StackDeployError(
          `Stack '${params.name}' failed to deploy with status '${currentStatus}': ${detail}`,
          {
            stackName: params.name,
            status: currentStatus,
            failureReasons: reasons,
          },
        );
      }

      if (!IN_PROGRESS_STATUSES.has(currentStatus)) {
        throw new StackDeployError(
          `Stack '${params.name}' reached unexpected status '${currentStatus}'`,
          { stackName: params.name, status: currentStatus },
        );
      }

      await this.sleep(pollInterval);
    }

    throw new StackDeployError(
      `Timed out waiting for stack '${params.name}' deployment to complete`,
      { stackName: params.name },
    );
  }

  /**
   * Retrieves stack outputs as a key-value record.
   */
  async getStackOutputs(name: string): Promise<Record<string, string>> {
    const stack = await this.describeStack(name);
    if (!stack || stack.StackStatus === "DELETE_COMPLETE") {
      return {};
    }
    return this.extractOutputs(stack.Outputs);
  }

  /**
   * Checks whether a stack exists and is not DELETE_COMPLETE.
   */
  async stackExists(name: string): Promise<boolean> {
    const stack = await this.describeStack(name);
    return stack !== undefined && stack.StackStatus !== "DELETE_COMPLETE";
  }

  /**
   * Deletes a stack and waits for completion while streaming progress events.
   */
  async deleteStack(
    name: string,
    options: {
      onProgress?: (event: StackEventInfo) => void;
      pollIntervalMs?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<void> {
    const exists = await this.stackExists(name);
    if (!exists) {
      return;
    }

    const pollInterval = options.pollIntervalMs ?? 2000;
    const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;
    const deadline = Date.now() + timeoutMs;

    await this.cfnClient.send(
      new DeleteStackCommand({
        StackName: name,
      }),
    );

    const seenEventIds = new Set<string>();
    const failureEvents: StackEventInfo[] = [];

    while (Date.now() <= deadline) {
      await this.pollAndStreamEvents(name, seenEventIds, options.onProgress, failureEvents);

      const stack = await this.describeStack(name);

      if (stack === undefined || stack.StackStatus === "DELETE_COMPLETE") {
        return;
      }

      if (stack.StackStatus === "DELETE_FAILED") {
        const reasons = failureEvents.map(
          (e) =>
            `${e.logicalResourceId} (${e.resourceType}): ${e.resourceStatusReason || e.resourceStatus}`,
        );
        throw new StackDeployError(
          `Failed to delete stack '${name}': ${reasons.join("; ") || "DELETE_FAILED"}`,
          {
            stackName: name,
            status: "DELETE_FAILED",
            failureReasons: reasons,
          },
        );
      }

      await this.sleep(pollInterval);
    }

    throw new StackDeployError(`Timed out waiting for stack '${name}' deletion`, {
      stackName: name,
      status: "DELETE_TIMEOUT",
    });
  }

  /**
   * Empties an S3 bucket completely by removing all object versions and delete markers.
   */
  async emptyBucket(bucketName: string): Promise<void> {
    try {
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      let isTruncated = true;

      while (isTruncated) {
        const response = await this.s3Client.send(
          new ListObjectVersionsCommand({
            Bucket: bucketName,
            KeyMarker: keyMarker,
            VersionIdMarker: versionIdMarker,
          }),
        );

        const toDelete: Array<{ Key: string; VersionId?: string }> = [];

        for (const version of response.Versions ?? []) {
          if (version.Key) {
            toDelete.push({
              Key: version.Key,
              VersionId: version.VersionId,
            });
          }
        }

        for (const marker of response.DeleteMarkers ?? []) {
          if (marker.Key) {
            toDelete.push({
              Key: marker.Key,
              VersionId: marker.VersionId,
            });
          }
        }

        if (toDelete.length > 0) {
          await this.s3Client.send(
            new DeleteObjectsCommand({
              Bucket: bucketName,
              Delete: {
                Objects: toDelete,
                Quiet: true,
              },
            }),
          );
        }

        isTruncated = response.IsTruncated ?? false;
        keyMarker = response.NextKeyMarker;
        versionIdMarker = response.NextVersionIdMarker;
      }
    } catch (err) {
      if (
        err instanceof NoSuchBucket ||
        (err as Error).name === "NoSuchBucket" ||
        (err as Error).name === "NotFound"
      ) {
        return;
      }
      throw err;
    }
  }

  private async describeStack(name: string) {
    try {
      const response = await this.cfnClient.send(
        new DescribeStacksCommand({
          StackName: name,
        }),
      );
      return response.Stacks?.[0];
    } catch (err) {
      const name = (err as Error).name;
      const message = (err as Error).message || "";
      if (name === "ValidationError" && /does not exist/i.test(message)) {
        return undefined;
      }
      throw err;
    }
  }

  private async pollAndStreamEvents(
    stackName: string,
    seenEventIds: Set<string>,
    onProgress?: (event: StackEventInfo) => void,
    failureEvents?: StackEventInfo[],
  ): Promise<void> {
    try {
      const response = await this.cfnClient.send(
        new DescribeStackEventsCommand({
          StackName: stackName,
        }),
      );

      const rawEvents: StackEvent[] = response.StackEvents ?? [];
      // Sort events chronologically from oldest to newest
      const sortedEvents = [...rawEvents].sort(
        (a, b) => (a.Timestamp?.getTime() ?? 0) - (b.Timestamp?.getTime() ?? 0),
      );

      for (const ev of sortedEvents) {
        const id = ev.EventId;
        if (!id || seenEventIds.has(id)) continue;
        seenEventIds.add(id);

        const eventInfo: StackEventInfo = {
          eventId: id,
          logicalResourceId: ev.LogicalResourceId ?? "",
          resourceType: ev.ResourceType ?? "",
          resourceStatus: ev.ResourceStatus ?? "",
          resourceStatusReason: ev.ResourceStatusReason,
          timestamp: ev.Timestamp ?? new Date(),
        };

        if (
          eventInfo.resourceStatus.endsWith("_FAILED") ||
          (eventInfo.resourceStatusReason &&
            /failed|error|rolled back|resource handler returned/i.test(
              eventInfo.resourceStatusReason,
            ))
        ) {
          failureEvents?.push(eventInfo);
        }

        onProgress?.(eventInfo);
      }
    } catch (err) {
      // Ignore transient errors when fetching events during stack operations
      const msg = (err as Error).message || "";
      if (!/does not exist/i.test(msg)) {
        // Only ignore does not exist
      }
    }
  }

  private async safeDeleteChangeSet(stackName: string, changeSetName: string): Promise<void> {
    try {
      await this.cfnClient.send(
        new DeleteChangeSetCommand({
          StackName: stackName,
          ChangeSetName: changeSetName,
        }),
      );
    } catch {
      // Ignore cleanup error
    }
  }

  private extractOutputs(
    outputs?: Array<{ OutputKey?: string; OutputValue?: string }>,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const out of outputs ?? []) {
      if (out.OutputKey && out.OutputValue !== undefined) {
        result[out.OutputKey] = out.OutputValue;
      }
    }
    return result;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
