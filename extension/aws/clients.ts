/**
 * AWS SDK Client Factory and Error Mapping Extension adapter (T4.2).
 */

import { AwsClientFactory, type ClientFactoryOptions } from "../../core/aws/clients.js";
import type { LocalConfig } from "../../shared/config.js";

export * from "../../core/aws/clients.js";

/**
 * Creates an AwsClientFactory pre-configured from LocalConfig.
 */
export function getClientFactoryFromConfig(
  config?: LocalConfig,
  overrides?: ClientFactoryOptions,
): AwsClientFactory {
  const region =
    overrides?.region ||
    config?.aws.region ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    "us-east-1";
  const profile =
    overrides?.profile !== undefined
      ? overrides.profile
      : config?.aws.profile || process.env.AWS_PROFILE;

  return new AwsClientFactory({
    region,
    profile,
    maxAttempts: overrides?.maxAttempts ?? 5,
  });
}
