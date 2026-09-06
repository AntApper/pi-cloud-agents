/**
 * Account ID and secret masking utilities.
 * Ensures 12-digit AWS account numbers and credential strings never leak into logs, docs, or evidence.
 */

// Regex for AWS 12-digit account ID (standalone or within ARNs)
const AWS_ACCOUNT_ID_REGEX = /\b\d{12}\b/g;
const AWS_ARN_ACCOUNT_REGEX = /(arn:aws[a-z0-9-]*:[a-z0-9-]*:[a-z0-9-]*:)(\d{12})(:)/g;

/**
 * Mask 12-digit AWS account IDs in a string.
 */
export function maskAccountId(text: string, replacement = "<ACCOUNT_ID>"): string {
  if (!text || typeof text !== "string") {
    return text;
  }
  // Replace account ID in ARN pattern first, then standalone 12-digit numbers
  let masked = text.replace(AWS_ARN_ACCOUNT_REGEX, `$1${replacement}$3`);
  masked = masked.replace(AWS_ACCOUNT_ID_REGEX, replacement);
  return masked;
}

/**
 * Mask an ARN's account ID component.
 */
export function maskArn(arn: string, replacement = "<ACCOUNT_ID>"): string {
  return maskAccountId(arn, replacement);
}

/**
 * Mask known secret strings in a text.
 */
export function maskSecrets(text: string, secrets: string[] = []): string {
  if (!text || typeof text !== "string") {
    return text;
  }
  let masked = maskAccountId(text);
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      masked = masked.replaceAll(secret, "[REDACTED]");
    }
  }
  return masked;
}

/**
 * Deeply clone and mask string values inside objects, arrays, and errors.
 */
export function maskObject<T>(value: T, secrets: string[] = []): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return maskSecrets(value, secrets) as unknown as T;
  }
  if (value instanceof Error) {
    const cloned = new Error(maskSecrets(value.message, secrets));
    cloned.name = value.name;
    if (value.stack) {
      cloned.stack = maskSecrets(value.stack, secrets);
    }
    return cloned as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskObject(item, secrets)) as unknown as T;
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = maskObject(v, secrets);
    }
    return result as T;
  }
  return value;
}
