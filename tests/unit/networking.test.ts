/**
 * Unit tests for Networking & Connector configuration (T5.5).
 */

import { describe, expect, it } from "vitest";
import { LocalConfigSchema } from "../../shared/config.js";

describe("T5.5 Networking and VPC Egress Connector Configuration", () => {
  it("validates egressConnectorArn in LocalConfig schema", () => {
    const validConfig = {
      aws: { region: "us-east-1" },
      stackName: "pi-cloud-agents-core",
      image: { name: "pi-cloud-agents-runner", memoryMiB: 4096 },
      defaults: {
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        maxDurationHours: 4,
        idle: { suspendAfterMin: 15, terminateAfterSuspendedMin: 120 },
        maxConcurrent: 3,
        archiveRetentionDays: 30,
        controllerCadenceMin: 1,
      },
      providers: { synced: ["anthropic"], oauthOptIn: [], bedrockRole: false },
      github: { mode: "none" as const },
      egressConnectorArn: "arn:aws:lambda:us-east-1:123456789012:network-connector:corp-vpc-egress",
    };

    const parsed = LocalConfigSchema.parse(validConfig);
    expect(parsed.egressConnectorArn).toBe(
      "arn:aws:lambda:us-east-1:123456789012:network-connector:corp-vpc-egress",
    );
  });
});
