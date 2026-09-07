import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
  SecretsManagerClient,
  TagResourceCommand,
  UpdateSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { collectPages } from "./paginate.js";

/**
 * Generates the Secrets Manager secret name for a synced pi provider auth entry.
 * Pattern: pi-cloud-agents/<stack>/pi-auth/<provider>
 */
export function formatPiAuthSecretName(stack: string, provider: string): string {
  return `pi-cloud-agents/${stack}/pi-auth/${provider}`;
}

/**
 * Generates the Secrets Manager secret name for the global GitHub PAT token.
 * Pattern: pi-cloud-agents/<stack>/github/token
 */
export function formatGitHubSecretName(stack: string): string {
  return `pi-cloud-agents/${stack}/github/token`;
}

/**
 * Generates the Secrets Manager secret name for a run-scoped secret.
 * Pattern: pi-cloud-agents/<stack>/runs/<runId>/<name>
 */
export function formatRunSecretName(stack: string, runId: string, name: string): string {
  return `pi-cloud-agents/${stack}/runs/${runId}/${name}`;
}

/**
 * Checks whether a secret name follows the run-scoped pattern:
 * pi-cloud-agents/<stack>/runs/<runId>/...
 */
export function isRunScopedSecretName(name: string): boolean {
  return /^pi-cloud-agents\/[^/]+\/runs\/[^/]+\/.+/.test(name);
}

export interface AwsSecretsStoreOptions {
  client?: SecretsManagerClient;
  region?: string;
}

export interface PutSecretOptions {
  kmsKeyId?: string;
  tags?: Record<string, string>;
  description?: string;
}

export interface DeleteSecretOptions {
  force?: boolean;
  recoveryWindowInDays?: number;
}

/**
 * Secrets store wrapping AWS Secrets Manager for pi credentials, GitHub tokens,
 * and ephemeral run-scoped credentials.
 */
export class AwsSecretsStore {
  private readonly client: SecretsManagerClient;

  constructor(options: AwsSecretsStoreOptions = {}) {
    this.client =
      options.client ??
      new SecretsManagerClient({
        region: options.region ?? process.env.AWS_REGION ?? "us-east-1",
      });
  }

  /**
   * Puts a secret value. If the secret does not exist, it creates it.
   * If it already exists, it updates the value (and optionally tags/KMS).
   */
  async putSecret(
    name: string,
    value: string,
    options: PutSecretOptions = {},
  ): Promise<{ arn?: string; versionId?: string }> {
    const formattedTags = options.tags
      ? Object.entries(options.tags).map(([Key, Value]) => ({ Key, Value }))
      : undefined;

    try {
      const response = await this.client.send(
        new CreateSecretCommand({
          Name: name,
          SecretString: value,
          KmsKeyId: options.kmsKeyId,
          Description: options.description,
          Tags: formattedTags,
        }),
      );
      return {
        arn: response.ARN,
        versionId: response.VersionId,
      };
    } catch (err) {
      if (
        err instanceof ResourceExistsException ||
        (err as Error).name === "ResourceExistsException"
      ) {
        // Secret already exists: update secret value
        const putRes = await this.client.send(
          new PutSecretValueCommand({
            SecretId: name,
            SecretString: value,
          }),
        );

        // Update KMS key or description if specified
        if (options.kmsKeyId !== undefined || options.description !== undefined) {
          await this.client.send(
            new UpdateSecretCommand({
              SecretId: name,
              KmsKeyId: options.kmsKeyId,
              Description: options.description,
            }),
          );
        }

        // Update tags if provided
        if (formattedTags && formattedTags.length > 0) {
          await this.client.send(
            new TagResourceCommand({
              SecretId: name,
              Tags: formattedTags,
            }),
          );
        }

        return {
          arn: putRes.ARN,
          versionId: putRes.VersionId,
        };
      }
      throw err;
    }
  }

  /**
   * Fetches a secret string. Returns undefined if the secret does not exist.
   * Never exposes or logs secret values.
   */
  async getSecret(name: string): Promise<string | undefined> {
    try {
      const response = await this.client.send(
        new GetSecretValueCommand({
          SecretId: name,
        }),
      );

      if (response.SecretString !== undefined) {
        return response.SecretString;
      }
      if (response.SecretBinary !== undefined) {
        return Buffer.from(response.SecretBinary).toString("utf-8");
      }
      return undefined;
    } catch (err) {
      if (
        err instanceof ResourceNotFoundException ||
        (err as Error).name === "ResourceNotFoundException"
      ) {
        return undefined;
      }
      throw err;
    }
  }

  /**
   * Checks whether a secret exists and has not been marked for deletion.
   */
  async secretExists(name: string): Promise<boolean> {
    try {
      const response = await this.client.send(
        new DescribeSecretCommand({
          SecretId: name,
        }),
      );
      if (response.DeletedDate !== undefined) {
        return false;
      }
      return true;
    } catch (err) {
      if (
        err instanceof ResourceNotFoundException ||
        (err as Error).name === "ResourceNotFoundException"
      ) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Deletes a secret.
   * Run-scoped secrets and requests with force=true use ForceDeleteWithoutRecovery.
   * Standard stack secrets use RecoveryWindowInDays (default 7 days).
   * Gracefully ignores ResourceNotFoundException.
   */
  async deleteSecret(name: string, options: DeleteSecretOptions = {}): Promise<void> {
    const isRunScoped = isRunScopedSecretName(name);
    const forceDelete = options.force === true || isRunScoped;

    try {
      if (forceDelete) {
        await this.client.send(
          new DeleteSecretCommand({
            SecretId: name,
            ForceDeleteWithoutRecovery: true,
          }),
        );
      } else {
        await this.client.send(
          new DeleteSecretCommand({
            SecretId: name,
            RecoveryWindowInDays: options.recoveryWindowInDays ?? 7,
          }),
        );
      }
    } catch (err) {
      if (
        err instanceof ResourceNotFoundException ||
        (err as Error).name === "ResourceNotFoundException"
      ) {
        return;
      }
      throw err;
    }
  }

  /**
   * Lists all run-scoped secret names for a given stack and runId.
   * NEVER fetches secret values.
   */
  async listRunScopedSecrets(stack: string, runId: string): Promise<string[]> {
    const prefix = `pi-cloud-agents/${stack}/runs/${runId}/`;
    return this.listSecretsByPrefix(prefix);
  }

  /**
   * Lists all secret names under a stack prefix (e.g., during stack destroy).
   * NEVER fetches secret values.
   */
  async listStackSecrets(stack: string): Promise<string[]> {
    const prefix = `pi-cloud-agents/${stack}/`;
    return this.listSecretsByPrefix(prefix);
  }

  /**
   * Helper to list secret names matching a prefix using ListSecrets pagination.
   * NEVER calls GetSecretValueCommand.
   */
  private async listSecretsByPrefix(prefix: string): Promise<string[]> {
    const secrets = await collectPages({
      fetchPage: (NextToken: string | undefined) =>
        this.client.send(
          new ListSecretsCommand({
            NextToken,
            Filters: [{ Key: "name", Values: [prefix] }],
          }),
        ),
      nextToken: (page) => page.NextToken,
      items: (page) => page.SecretList,
    });

    const matchingNames: string[] = [];
    for (const secret of secrets) {
      // Exclude secrets that are already scheduled for deletion
      if (secret.Name?.startsWith(prefix) && secret.DeletedDate === undefined) {
        matchingNames.push(secret.Name);
      }
    }

    return matchingNames;
  }
}
