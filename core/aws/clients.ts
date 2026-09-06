/**
 * AWS SDK Client Factory and Actionable Error Mapping (T4.2).
 * - Creates, configures, and memoizes AWS SDK clients with adaptive retry and profile resolution.
 * - Maps low-level AWS exceptions to user-facing actionable error messages following
 *   what failed -> why -> what to do next format (§1.0 principle 6).
 */

import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { IAMClient } from "@aws-sdk/client-iam";
import { LambdaMicrovmsClient } from "@aws-sdk/client-lambda-microvms";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ServiceQuotasClient } from "@aws-sdk/client-service-quotas";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { maskAccountId, maskArn } from "./mask.js";
import { SUPPORTED_MICROVM_REGIONS, isMicrovmRegionSupported } from "./readiness.js";

export interface ClientFactoryOptions {
  region?: string;
  profile?: string;
  maxAttempts?: number;
}

export interface ClientOptions {
  region?: string;
  profile?: string;
  maxAttempts?: number;
}

/**
 * Actionable Mapped AWS Error.
 * Follows the what failed -> why (code) -> do this next pattern.
 */
export class MappedAwsError extends Error {
  readonly code: string;
  readonly remediation: string;
  readonly originalError: unknown;
  readonly region?: string;
  readonly action?: string;

  constructor(options: {
    message: string;
    code: string;
    remediation: string;
    originalError?: unknown;
    region?: string;
    action?: string;
  }) {
    super(options.message);
    this.name = "MappedAwsError";
    this.code = options.code;
    this.remediation = options.remediation;
    this.originalError = options.originalError;
    this.region = options.region;
    this.action = options.action;
  }

  /**
   * Formats the error into a clean multi-line user-facing message.
   */
  toUserMessage(): string {
    return [
      `What failed: ${this.message}`,
      `Why (${this.code}): ${this.originalError instanceof Error ? maskAccountId(this.originalError.message) : "Operation failed"}`,
      `What to do next: ${this.remediation}`,
    ].join("\n");
  }
}

/**
 * Maps raw AWS SDK errors to actionable user-facing messages.
 */
export function mapAwsError(
  err: unknown,
  context?: {
    region?: string;
    action?: string;
    resource?: string;
    stackName?: string;
  },
): MappedAwsError {
  const region = context?.region || process.env.AWS_REGION || "us-east-1";
  const action = context?.action || "AWS operation";

  if (err instanceof MappedAwsError) {
    return err;
  }

  const rawName = (err as Error)?.name || "";
  const rawMsg = (err as Error)?.message || String(err);
  const cleanMsg = maskAccountId(rawMsg);

  // 1. IAM Access Denied / Unauthorized
  if (
    rawName === "AccessDeniedException" ||
    rawName === "AccessDenied" ||
    rawName === "UnauthorizedOperation" ||
    /is not authorized to perform|Access Denied|status code: 403|Forbidden/i.test(cleanMsg)
  ) {
    const actionMatch = cleanMsg.match(/is not authorized to perform:\s*([a-zA-Z0-9:*]+)/i);
    const missingAction = actionMatch ? actionMatch[1] : action;
    return new MappedAwsError({
      message: `Access denied while performing '${missingAction}' in region ${region}`,
      code: "ACCESS_DENIED",
      remediation: `Ensure your AWS IAM user or role has the required permissions. Attach the 'OperatorPolicy' managed policy created by the pi-cloud-agents core stack or run '/cloud iam-policy'.`,
      originalError: err,
      region,
      action: missingAction,
    });
  }

  // 2. Service Quota / Rate Limits
  if (
    rawName === "ServiceQuotaExceededException" ||
    rawName === "QuotaExceededException" ||
    rawName === "TooManyRequestsException" ||
    rawName === "ThrottlingException" ||
    /quota exceeded|rate exceeded|throttled|Too Many Requests|status code: 429/i.test(cleanMsg)
  ) {
    return new MappedAwsError({
      message: `Service quota or rate limit exceeded for ${action} in region ${region}`,
      code: "QUOTA_EXCEEDED",
      remediation:
        "Request a service quota increase in the AWS Service Quotas console for Lambda MicroVM memory or concurrent instances, or wait a few moments and retry with backoff.",
      originalError: err,
      region,
      action,
    });
  }

  // 3. Expired / Invalid Credentials
  if (
    rawName === "ExpiredToken" ||
    rawName === "ExpiredTokenException" ||
    rawName === "RequestExpired" ||
    rawName === "InvalidClientTokenId" ||
    rawName === "CredentialsProviderError" ||
    /security token included in the request is invalid|expired token|could not load credentials/i.test(
      cleanMsg,
    )
  ) {
    return new MappedAwsError({
      message: `AWS credentials are missing, invalid, or expired for region ${region}`,
      code: "EXPIRED_CREDENTIALS",
      remediation: `Refresh your AWS credentials. If using AWS SSO, run 'aws sso login'. Verify your active profile using 'export AWS_PROFILE=<profile>' or check ~/.aws/credentials.`,
      originalError: err,
      region,
      action,
    });
  }

  // 4. Region Support
  if (
    !isMicrovmRegionSupported(region) ||
    /not supported in this region|invalid region|Endpoint URL/i.test(cleanMsg)
  ) {
    return new MappedAwsError({
      message: `Lambda MicroVMs are not supported or unavailable in region '${region}'`,
      code: "UNSUPPORTED_REGION",
      remediation: `Switch your AWS region to a supported region: ${SUPPORTED_MICROVM_REGIONS.join(", ")}. Run '/cloud config' to update your default region.`,
      originalError: err,
      region,
      action,
    });
  }

  // 5. Resource Not Found
  if (
    rawName === "ResourceNotFoundException" ||
    rawName === "NoSuchBucket" ||
    rawName === "NoSuchKey" ||
    rawName === "NotFound" ||
    rawName === "404" ||
    /does not exist|not found|Stack with id .* does not exist/i.test(cleanMsg)
  ) {
    const resourceName = context?.resource ? ` '${maskArn(context.resource)}'` : "";
    return new MappedAwsError({
      message: `Requested AWS resource${resourceName} was not found in region ${region}`,
      code: "RESOURCE_NOT_FOUND",
      remediation: `Verify that the resource exists and has not been deleted. If the infrastructure is not yet set up, run '/cloud setup'.`,
      originalError: err,
      region,
      action,
    });
  }

  // 6. Network & Connectivity Errors
  if (
    /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|NetworkingError|TimeoutError|fetch failed/i.test(
      cleanMsg,
    )
  ) {
    return new MappedAwsError({
      message: `Network connection to AWS services in region ${region} failed or timed out`,
      code: "NETWORK_ERROR",
      remediation: `Check your internet connectivity and verify you can reach AWS endpoints in ${region}. If behind a proxy, ensure HTTPS_PROXY is configured.`,
      originalError: err,
      region,
      action,
    });
  }

  // 7. General Fallback
  return new MappedAwsError({
    message: `${action} failed in region ${region}: ${cleanMsg}`,
    code: rawName || "AWS_ERROR",
    remediation: `Inspect error details above and check AWS CloudWatch logs or run '/cloud doctor'.`,
    originalError: err,
    region,
    action,
  });
}

/**
 * Centralized, memoized factory for AWS SDK clients with adaptive retry and credential configuration.
 */
export class AwsClientFactory {
  private static defaultInstance?: AwsClientFactory;
  private readonly clientCache = new Map<string, unknown>();
  private readonly defaultOptions: ClientFactoryOptions;

  constructor(options: ClientFactoryOptions = {}) {
    this.defaultOptions = {
      region:
        options.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
      profile: options.profile || process.env.AWS_PROFILE,
      maxAttempts: options.maxAttempts ?? 5,
    };
  }

  /**
   * Returns default shared factory singleton instance.
   */
  static get default(): AwsClientFactory {
    if (!AwsClientFactory.defaultInstance) {
      AwsClientFactory.defaultInstance = new AwsClientFactory();
    }
    return AwsClientFactory.defaultInstance;
  }

  /**
   * Resets default shared factory instance.
   */
  static resetDefault(): void {
    AwsClientFactory.defaultInstance = undefined;
  }

  /**
   * Generates a cache key for memoizing client instances.
   */
  private getCacheKey(clientType: string, region: string, profile?: string): string {
    return `${clientType}:${region}:${profile || "default"}`;
  }

  /**
   * Resolves unified client configuration merged with defaults.
   */
  private resolveConfig(options?: ClientOptions): {
    region: string;
    profile?: string;
    maxAttempts: number;
  } {
    return {
      region: options?.region || this.defaultOptions.region || "us-east-1",
      profile: options?.profile !== undefined ? options.profile : this.defaultOptions.profile,
      maxAttempts: options?.maxAttempts ?? this.defaultOptions.maxAttempts ?? 5,
    };
  }

  /**
   * Retrieves or creates a memoized LambdaMicrovmsClient.
   */
  getLambdaMicrovmsClient(options?: ClientOptions): LambdaMicrovmsClient {
    const config = this.resolveConfig(options);
    const key = this.getCacheKey("LambdaMicrovmsClient", config.region, config.profile);

    let client = this.clientCache.get(key) as LambdaMicrovmsClient | undefined;
    if (!client) {
      client = new LambdaMicrovmsClient({
        region: config.region,
        maxAttempts: config.maxAttempts,
        ...(config.profile ? { profile: config.profile } : {}),
      });
      this.clientCache.set(key, client);
    }
    return client;
  }

  /**
   * Retrieves or creates a memoized CloudFormationClient.
   */
  getCloudFormationClient(options?: ClientOptions): CloudFormationClient {
    const config = this.resolveConfig(options);
    const key = this.getCacheKey("CloudFormationClient", config.region, config.profile);

    let client = this.clientCache.get(key) as CloudFormationClient | undefined;
    if (!client) {
      client = new CloudFormationClient({
        region: config.region,
        maxAttempts: config.maxAttempts,
        ...(config.profile ? { profile: config.profile } : {}),
      });
      this.clientCache.set(key, client);
    }
    return client;
  }

  /**
   * Retrieves or creates a memoized S3Client.
   */
  getS3Client(options?: ClientOptions): S3Client {
    const config = this.resolveConfig(options);
    const key = this.getCacheKey("S3Client", config.region, config.profile);

    let client = this.clientCache.get(key) as S3Client | undefined;
    if (!client) {
      client = new S3Client({
        region: config.region,
        maxAttempts: config.maxAttempts,
        ...(config.profile ? { profile: config.profile } : {}),
      });
      this.clientCache.set(key, client);
    }
    return client;
  }

  /**
   * Retrieves or creates a memoized SecretsManagerClient.
   */
  getSecretsManagerClient(options?: ClientOptions): SecretsManagerClient {
    const config = this.resolveConfig(options);
    const key = this.getCacheKey("SecretsManagerClient", config.region, config.profile);

    let client = this.clientCache.get(key) as SecretsManagerClient | undefined;
    if (!client) {
      client = new SecretsManagerClient({
        region: config.region,
        maxAttempts: config.maxAttempts,
        ...(config.profile ? { profile: config.profile } : {}),
      });
      this.clientCache.set(key, client);
    }
    return client;
  }

  /**
   * Retrieves or creates a memoized STSClient.
   */
  getSTSClient(options?: ClientOptions): STSClient {
    const config = this.resolveConfig(options);
    const key = this.getCacheKey("STSClient", config.region, config.profile);

    let client = this.clientCache.get(key) as STSClient | undefined;
    if (!client) {
      client = new STSClient({
        region: config.region,
        maxAttempts: config.maxAttempts,
        ...(config.profile ? { profile: config.profile } : {}),
      });
      this.clientCache.set(key, client);
    }
    return client;
  }

  /**
   * Retrieves or creates a memoized CloudWatchLogsClient.
   */
  getCloudWatchLogsClient(options?: ClientOptions): CloudWatchLogsClient {
    const config = this.resolveConfig(options);
    const key = this.getCacheKey("CloudWatchLogsClient", config.region, config.profile);

    let client = this.clientCache.get(key) as CloudWatchLogsClient | undefined;
    if (!client) {
      client = new CloudWatchLogsClient({
        region: config.region,
        maxAttempts: config.maxAttempts,
        ...(config.profile ? { profile: config.profile } : {}),
      });
      this.clientCache.set(key, client);
    }
    return client;
  }

  /**
   * Retrieves or creates a memoized IAMClient.
   */
  getIAMClient(options?: ClientOptions): IAMClient {
    const config = this.resolveConfig(options);
    const key = this.getCacheKey("IAMClient", config.region, config.profile);

    let client = this.clientCache.get(key) as IAMClient | undefined;
    if (!client) {
      client = new IAMClient({
        region: config.region,
        maxAttempts: config.maxAttempts,
        ...(config.profile ? { profile: config.profile } : {}),
      });
      this.clientCache.set(key, client);
    }
    return client;
  }

  /**
   * Retrieves or creates a memoized SSMClient.
   */
  getSSMClient(options?: ClientOptions): SSMClient {
    const config = this.resolveConfig(options);
    const key = this.getCacheKey("SSMClient", config.region, config.profile);

    let client = this.clientCache.get(key) as SSMClient | undefined;
    if (!client) {
      client = new SSMClient({
        region: config.region,
        maxAttempts: config.maxAttempts,
        ...(config.profile ? { profile: config.profile } : {}),
      });
      this.clientCache.set(key, client);
    }
    return client;
  }

  /**
   * Retrieves or creates a memoized ServiceQuotasClient.
   */
  getServiceQuotasClient(options?: ClientOptions): ServiceQuotasClient {
    const config = this.resolveConfig(options);
    const key = this.getCacheKey("ServiceQuotasClient", config.region, config.profile);

    let client = this.clientCache.get(key) as ServiceQuotasClient | undefined;
    if (!client) {
      client = new ServiceQuotasClient({
        region: config.region,
        maxAttempts: config.maxAttempts,
        ...(config.profile ? { profile: config.profile } : {}),
      });
      this.clientCache.set(key, client);
    }
    return client;
  }

  /**
   * Clears all cached client instances.
   */
  clearCache(): void {
    this.clientCache.clear();
  }

  /**
   * Returns total number of active cached client instances.
   */
  getCachedCount(): number {
    return this.clientCache.size;
  }
}
