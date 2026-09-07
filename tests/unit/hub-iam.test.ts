/**
 * Unit tests for Cloud Hub and IAM Helper (T4.15).
 */

import { describe, expect, it } from "vitest";
import {
  generateOperatorPolicyCfnYaml,
  generateOperatorPolicyJson,
} from "../../core/iam-helper.js";
import { formatPostSetupHub, formatPreSetupHub } from "../../extension/commands/hub.js";

describe("T4.15 Cloud Hub and IAM Helper", () => {
  describe("IAM Operator Policy", () => {
    it("generates valid operator policy JSON with required statements", () => {
      const policyJson = generateOperatorPolicyJson();
      const parsed = JSON.parse(policyJson);

      expect(parsed.Version).toBe("2012-10-17");
      expect(parsed.Statement.length).toBeGreaterThanOrEqual(5);

      const sids = parsed.Statement.map((s: { Sid: string }) => s.Sid);
      expect(sids).toContain("CloudFormationStackOps");
      expect(sids).toContain("MicrovmManagement");
      expect(sids).toContain("PassNetworkConnector");
      expect(sids).toContain("SecretsManagerOps");
      expect(sids).toContain("S3ArtifactStorage");
    });

    it("generates standalone CloudFormation YAML template for managed policy", () => {
      const yaml = generateOperatorPolicyCfnYaml("my-custom-operator-policy");

      expect(yaml).toContain("AWSTemplateFormatVersion");
      expect(yaml).toContain("my-custom-operator-policy");
      expect(yaml).toContain("AWS::IAM::ManagedPolicy");
      expect(yaml).toContain("PassNetworkConnector");
    });
  });

  describe("Cloud Hub", () => {
    it("formats pre-setup hub within width bounds", () => {
      const output = formatPreSetupHub(80);
      expect(output).toContain("pi cloud agents");
      expect(output).toContain("Quick Setup");
      expect(output).toContain("Estimated idle cost: $0.00");

      for (const line of output.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(84);
      }
    });

    it("formats post-setup hub with live fleet counts", () => {
      const output = formatPostSetupHub(2, 3, 5, 80);
      expect(output).toContain("Fleet Status");
      expect(output).toContain("2 running");
      expect(output).toContain("3 idle");
      expect(output).toContain("/cloud new");

      for (const line of output.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(84);
      }
    });
  });
});
