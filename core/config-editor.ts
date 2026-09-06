/**
 * Configuration Editor Engine (T4.11).
 * Pure core module providing dot-path get/set, type parsing, schema validation,
 * migration warnings, and width-safe table rendering for LocalConfig.
 */

import { type LocalConfig, LocalConfigSchema } from "../shared/config.js";
import { SUPPORTED_MICROVM_REGIONS, isMicrovmRegionSupported } from "./aws/readiness.js";
import { getLocalConfigPath } from "./config.js";

export interface ConfigFieldMeta {
  key: string;
  section: "AWS" | "Image" | "Defaults" | "Providers" | "GitHub";
  type: "string" | "number" | "boolean" | "string[]" | "enum";
  description: string;
  allowedValues?: readonly string[];
  min?: number;
  max?: number;
}

export const CONFIG_FIELDS: ConfigFieldMeta[] = [
  {
    key: "aws.profile",
    section: "AWS",
    type: "string",
    description: "AWS CLI profile name for credentials",
  },
  {
    key: "aws.region",
    section: "AWS",
    type: "string",
    description: "AWS region for MicroVMs and infrastructure",
    allowedValues: SUPPORTED_MICROVM_REGIONS,
  },
  {
    key: "image.name",
    section: "Image",
    type: "string",
    description: "Lambda MicroVM runner image name",
  },
  {
    key: "image.memoryMiB",
    section: "Image",
    type: "number",
    min: 512,
    max: 8192,
    description: "MicroVM baseline memory size in MiB",
  },
  {
    key: "defaults.model.provider",
    section: "Defaults",
    type: "string",
    description: "Default LLM provider (e.g. anthropic, openai)",
  },
  {
    key: "defaults.model.id",
    section: "Defaults",
    type: "string",
    description: "Default model identifier",
  },
  {
    key: "defaults.maxDurationHours",
    section: "Defaults",
    type: "number",
    min: 1,
    max: 8,
    description: "Maximum run duration in hours (hard cap 8h)",
  },
  {
    key: "defaults.idle.suspendAfterMin",
    section: "Defaults",
    type: "number",
    min: 0,
    max: 1440,
    description: "Idle duration in minutes before MicroVM suspend",
  },
  {
    key: "defaults.idle.terminateAfterSuspendedMin",
    section: "Defaults",
    type: "number",
    min: 0,
    max: 1440,
    description: "Minutes in suspended state before MicroVM termination",
  },
  {
    key: "defaults.maxConcurrent",
    section: "Defaults",
    type: "number",
    min: 1,
    max: 10,
    description: "Maximum concurrent active cloud runs",
  },
  {
    key: "defaults.archiveRetentionDays",
    section: "Defaults",
    type: "number",
    min: 0,
    max: 365,
    description: "Retention days for S3 workspace and log archives",
  },
  {
    key: "defaults.controllerCadenceMin",
    section: "Defaults",
    type: "number",
    min: 1,
    max: 5,
    description: "Controller Lambda polling interval in minutes (1 or 5)",
  },
  {
    key: "defaults.trustProjectConfig",
    section: "Defaults",
    type: "boolean",
    description: "Auto-approve repo .pi/ configuration without prompt",
  },
  {
    key: "defaults.autoPush",
    section: "Defaults",
    type: "boolean",
    description: "Automatically push git commits upon agent settlement",
  },
  {
    key: "defaults.egressConnectorArn",
    section: "Defaults",
    type: "string",
    description: "Custom VPC egress network connector ARN",
  },
  {
    key: "defaults.enableShell",
    section: "Defaults",
    type: "boolean",
    description: "Enable remote shell ingress on port 8022",
  },
  {
    key: "providers.synced",
    section: "Providers",
    type: "string[]",
    description: "List of provider credentials synced to AWS Secrets Manager",
  },
  {
    key: "providers.oauthOptIn",
    section: "Providers",
    type: "string[]",
    description: "Providers with explicit OAuth credentials sync opt-in",
  },
  {
    key: "providers.bedrockRole",
    section: "Providers",
    type: "boolean",
    description: "Enable Amazon Bedrock models via IAM execution role",
  },
  {
    key: "github.mode",
    section: "GitHub",
    type: "enum",
    allowedValues: ["secret", "none"] as const,
    description: "GitHub credential mode (secret or none)",
  },
  {
    key: "github.secretName",
    section: "GitHub",
    type: "string",
    description: "Secrets Manager secret name storing GitHub PAT",
  },
];

export interface SetConfigResult {
  config: LocalConfig;
  key: string;
  previousValue: unknown;
  newValue: unknown;
  warnings: string[];
}

/**
 * Retrieves a configuration value by dot-separated path.
 */
export function getConfigValue(config: LocalConfig, keyPath: string): unknown {
  const parts = keyPath.trim().split(".");
  let current: unknown = config;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Coerces a raw string or value into the expected field type.
 */
export function coerceConfigValue(meta: ConfigFieldMeta, rawValue: unknown): unknown {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    if (
      meta.type === "string" &&
      (meta.key === "aws.profile" ||
        meta.key === "defaults.egressConnectorArn" ||
        meta.key === "github.secretName")
    ) {
      return undefined;
    }
  }

  if (meta.type === "boolean") {
    if (typeof rawValue === "boolean") return rawValue;
    const str = String(rawValue).trim().toLowerCase();
    if (str === "true" || str === "1" || str === "yes" || str === "on") return true;
    if (str === "false" || str === "0" || str === "no" || str === "off") return false;
    throw new Error(
      `Invalid boolean value for '${meta.key}': expected true/false, got '${rawValue}'`,
    );
  }

  if (meta.type === "number") {
    if (typeof rawValue === "number" && !Number.isNaN(rawValue)) {
      validateNumberBounds(meta, rawValue);
      return rawValue;
    }
    const num = Number(rawValue);
    if (Number.isNaN(num)) {
      throw new Error(`Invalid number for '${meta.key}': '${rawValue}'`);
    }
    validateNumberBounds(meta, num);
    return num;
  }

  if (meta.type === "string[]") {
    if (Array.isArray(rawValue)) {
      return rawValue.map((item) => String(item).trim()).filter(Boolean);
    }
    const str = String(rawValue).trim();
    if (!str || str === "[]") return [];
    return str
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (meta.type === "enum") {
    const val = String(rawValue).trim();
    if (meta.allowedValues && !meta.allowedValues.includes(val)) {
      throw new Error(
        `Invalid value for '${meta.key}': expected one of [${meta.allowedValues.join(", ")}], got '${val}'`,
      );
    }
    return val;
  }

  // String
  const val = String(rawValue).trim();
  if (
    meta.key === "aws.region" &&
    (!isMicrovmRegionSupported(val) || (meta.allowedValues && !meta.allowedValues.includes(val)))
  ) {
    throw new Error(
      `Unsupported AWS region '${val}' for Lambda MicroVMs. Supported regions: ${SUPPORTED_MICROVM_REGIONS.join(", ")}`,
    );
  }

  if (meta.allowedValues && !meta.allowedValues.includes(val)) {
    throw new Error(
      `Invalid value for '${meta.key}': expected one of [${meta.allowedValues.join(", ")}], got '${val}'`,
    );
  }

  return val;
}

function validateNumberBounds(meta: ConfigFieldMeta, num: number): void {
  if (meta.min !== undefined && num < meta.min) {
    throw new Error(`Value ${num} for '${meta.key}' is below minimum allowed (${meta.min})`);
  }
  if (meta.max !== undefined && num > meta.max) {
    throw new Error(`Value ${num} for '${meta.key}' exceeds maximum allowed (${meta.max})`);
  }
}

/**
 * Updates a configuration value by dot-path and returns updated config with migration warnings.
 */
export function setConfigValue(
  config: LocalConfig,
  keyPath: string,
  rawValue: unknown,
): SetConfigResult {
  const cleanKey = keyPath.trim();
  const meta = CONFIG_FIELDS.find((f) => f.key === cleanKey);

  if (!meta) {
    throw new Error(
      `Unknown configuration key '${cleanKey}'. Run '/cloud config' to list valid keys.`,
    );
  }

  const previousValue = getConfigValue(config, cleanKey);
  const coercedValue = coerceConfigValue(meta, rawValue);

  // Deep clone config
  const updated: Record<string, unknown> = JSON.parse(JSON.stringify(config));
  const parts = cleanKey.split(".");
  let current: Record<string, unknown> = updated;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!current[part] || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  const lastPart = parts[parts.length - 1]!;
  if (coercedValue === undefined) {
    delete current[lastPart];
  } else {
    current[lastPart] = coercedValue;
  }

  // Validate entire config against LocalConfigSchema
  const validated = LocalConfigSchema.parse(updated);

  // Determine migration warnings
  const warnings: string[] = [];

  if (cleanKey === "aws.region" && previousValue !== coercedValue) {
    warnings.push(
      `Region changed to '${coercedValue}'. Run '/cloud setup' to create infrastructure in ${coercedValue}.`,
    );
  } else if (cleanKey === "aws.profile" && previousValue !== coercedValue) {
    warnings.push(
      `AWS profile changed to '${coercedValue || "(default)"}'. Run '/cloud setup' or '/cloud doctor' to verify account access.`,
    );
  } else if (cleanKey === "image.memoryMiB" && previousValue !== coercedValue) {
    warnings.push(
      `Memory allocation changed to ${coercedValue} MiB. Run '/cloud update' to rebuild the runner image with this memory size.`,
    );
  } else if (
    (cleanKey === "providers.synced" || cleanKey === "providers.oauthOptIn") &&
    JSON.stringify(previousValue) !== JSON.stringify(coercedValue)
  ) {
    warnings.push(
      "Provider sync list changed. Run '/cloud sync' to update credentials in AWS Secrets Manager.",
    );
  }

  return {
    config: validated,
    key: cleanKey,
    previousValue,
    newValue: coercedValue,
    warnings,
  };
}

/**
 * Renders formatted tables of all configuration keys and values.
 */
export function formatConfigView(config: LocalConfig, maxWidth = 80): string {
  const filePath = getLocalConfigPath();
  const width = Math.max(60, maxWidth);
  const lines: string[] = [];

  const title = " pi cloud agents · Configuration ";
  const topDashes = Math.max(0, width - 2 - title.length);
  lines.push(`┌${title}${"─".repeat(topDashes)}┐`);
  lines.push(`│ File: ${filePath.slice(0, width - 10).padEnd(width - 10)} │`);
  lines.push(`├${"─".repeat(width - 2)}┤`);

  const sections: Array<"AWS" | "Image" | "Defaults" | "Providers" | "GitHub"> = [
    "AWS",
    "Image",
    "Defaults",
    "Providers",
    "GitHub",
  ];

  for (const section of sections) {
    const fields = CONFIG_FIELDS.filter((f) => f.section === section);
    lines.push(`${`│ [${section}]`.padEnd(width - 1)}│`);

    for (const field of fields) {
      const val = getConfigValue(config, field.key);
      let valStr: string;
      if (val === undefined || val === null) {
        valStr = "(not set)";
      } else if (Array.isArray(val)) {
        valStr = val.length > 0 ? val.join(", ") : "(empty)";
      } else if (typeof val === "boolean") {
        valStr = val ? "true" : "false";
      } else {
        valStr = String(val);
      }

      const innerWidth = width - 5;
      const keyColWidth = Math.min(38, Math.floor(innerWidth * 0.55));
      const valColWidth = innerWidth - keyColWidth;
      const keyStr = (
        field.key.length > keyColWidth ? `${field.key.slice(0, keyColWidth - 1)}…` : field.key
      ).padEnd(keyColWidth);
      const valCol = valStr.slice(0, valColWidth).padEnd(valColWidth);
      lines.push(`│ ${keyStr} ${valCol} │`);
    }

    if (section !== sections[sections.length - 1]) {
      lines.push(`├${"─".repeat(width - 2)}┤`);
    }
  }

  lines.push(`├${"─".repeat(width - 2)}┤`);
  lines.push(`${"│ Usage: /cloud config <key> [value]".padEnd(width - 1)}│`);
  lines.push(`${"│ Example: /cloud config defaults.maxDurationHours 6".padEnd(width - 1)}│`);
  lines.push(`└${"─".repeat(width - 2)}┘`);

  return lines.join("\n");
}
