/**
 * Secrets Provider for in-VM MicroVM runner.
 * Provides access to AWS Secrets Manager with retries, jitter, and version handling,
 * alongside an in-memory FakeSecretsProvider for local harness and testing.
 */

import {
  GetSecretValueCommand,
  type GetSecretValueCommandOutput,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { ProtocolErrorCode } from "../shared/protocol.js";

/**
 * Common SecretsProvider interface.
 */
export interface SecretsProvider {
  get(name: string): Promise<string>;
}

export interface SecretsManagerProviderOptions {
  region?: string;
  client?: SecretsManagerClient;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  versionStage?: string;
}

/**
 * Structured error thrown when a requested secret is missing.
 */
export class SecretMissingError extends Error {
  public readonly code = ProtocolErrorCode.SECRET_MISSING;
  public readonly secretName: string;

  constructor(secretName: string, message?: string) {
    super(message ?? `Secret '${secretName}' was not found in Secrets Manager`);
    this.name = "SecretMissingError";
    this.secretName = secretName;
  }
}

/**
 * AWS Secrets Manager implementation of SecretsProvider.
 */
export class SecretsManagerProvider implements SecretsProvider {
  private readonly client: SecretsManagerClient;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly versionStage: string;

  constructor(options: SecretsManagerProviderOptions = {}) {
    this.client =
      options.client ??
      new SecretsManagerClient({
        region: options.region ?? process.env.AWS_REGION ?? "us-east-1",
      });
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 150;
    this.maxDelayMs = options.maxDelayMs ?? 2000;
    this.versionStage = options.versionStage ?? "AWSCURRENT";
  }

  /**
   * Retrieves secret value string from AWS Secrets Manager by secret name or ARN.
   */
  public async get(name: string): Promise<string> {
    let attempt = 0;

    while (true) {
      try {
        const command = new GetSecretValueCommand({
          SecretId: name,
          VersionStage: this.versionStage,
        });

        const response: GetSecretValueCommandOutput = await this.client.send(command);

        if (response.SecretString !== undefined) {
          return response.SecretString;
        }

        if (response.SecretBinary !== undefined) {
          return Buffer.from(response.SecretBinary).toString("utf8");
        }

        throw new SecretMissingError(
          name,
          `Secret '${name}' exists but contains no SecretString or SecretBinary value`,
        );
      } catch (err) {
        if (err instanceof ResourceNotFoundException) {
          throw new SecretMissingError(name, `Secret '${name}' does not exist in Secrets Manager`);
        }

        if (err instanceof SecretMissingError) {
          throw err;
        }

        attempt++;
        if (attempt > this.maxRetries) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const error = new Error(
            `Failed to retrieve secret '${name}' after ${this.maxRetries} retries: ${errMsg}`,
          );
          (error as { code?: string }).code = ProtocolErrorCode.SECRET_MISSING;
          throw error;
        }

        // Exponential backoff with jitter
        const delay = Math.min(
          this.maxDelayMs,
          this.baseDelayMs * 2 ** (attempt - 1) + Math.random() * this.baseDelayMs,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}

/**
 * In-memory SecretsProvider for testing and local simulation.
 */
export class FakeSecretsProvider implements SecretsProvider {
  private readonly secrets = new Map<string, string>();

  constructor(initialSecrets?: Record<string, string> | Map<string, string>) {
    if (initialSecrets instanceof Map) {
      for (const [k, v] of initialSecrets.entries()) {
        this.secrets.set(k, v);
      }
    } else if (initialSecrets) {
      for (const [k, v] of Object.entries(initialSecrets)) {
        this.secrets.set(k, v);
      }
    }
  }

  public set(name: string, value: string): void {
    this.secrets.set(name, value);
  }

  public delete(name: string): void {
    this.secrets.delete(name);
  }

  public async get(name: string): Promise<string> {
    const val = this.secrets.get(name);
    if (val === undefined) {
      throw new SecretMissingError(name);
    }
    return val;
  }
}
