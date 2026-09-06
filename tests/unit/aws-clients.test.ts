import { describe, expect, it } from "vitest";
import { AwsClientFactory, MappedAwsError, mapAwsError } from "../../core/aws/clients.js";
import { getClientFactoryFromConfig } from "../../extension/aws/clients.js";
import { DEFAULT_LOCAL_CONFIG } from "../../shared/config.js";

describe("AWS Client Factory & Error Mapping (T4.2)", () => {
  describe("AwsClientFactory Memoization & Lifecycle", () => {
    it("creates and memoizes AWS SDK client instances", () => {
      const factory = new AwsClientFactory({ region: "us-east-1" });
      expect(factory.getCachedCount()).toBe(0);

      const sts1 = factory.getSTSClient();
      const sts2 = factory.getSTSClient();
      expect(sts1).toBe(sts2);
      expect(factory.getCachedCount()).toBe(1);

      const cfn1 = factory.getCloudFormationClient();
      const cfn2 = factory.getCloudFormationClient();
      expect(cfn1).toBe(cfn2);
      expect(factory.getCachedCount()).toBe(2);

      const mvm1 = factory.getLambdaMicrovmsClient();
      const mvm2 = factory.getLambdaMicrovmsClient();
      expect(mvm1).toBe(mvm2);

      const s3 = factory.getS3Client();
      const sec = factory.getSecretsManagerClient();
      const cw = factory.getCloudWatchLogsClient();
      const iam = factory.getIAMClient();
      const ssm = factory.getSSMClient();
      const sq = factory.getServiceQuotasClient();

      expect(s3).toBeDefined();
      expect(sec).toBeDefined();
      expect(cw).toBeDefined();
      expect(iam).toBeDefined();
      expect(ssm).toBeDefined();
      expect(sq).toBeDefined();
      expect(factory.getCachedCount()).toBe(9);
    });

    it("partitions cache keys by region and profile", () => {
      const factory = new AwsClientFactory({ region: "us-east-1" });

      const clientUsEast1 = factory.getSTSClient({ region: "us-east-1" });
      const clientUsWest2 = factory.getSTSClient({ region: "us-west-2" });
      const clientProfile = factory.getSTSClient({
        region: "us-east-1",
        profile: "custom-profile",
      });

      expect(clientUsEast1).not.toBe(clientUsWest2);
      expect(clientUsEast1).not.toBe(clientProfile);
      expect(factory.getCachedCount()).toBe(3);
    });

    it("clears cached client instances", () => {
      const factory = new AwsClientFactory({ region: "us-east-1" });
      factory.getSTSClient();
      factory.getS3Client();
      expect(factory.getCachedCount()).toBe(2);

      factory.clearCache();
      expect(factory.getCachedCount()).toBe(0);
    });

    it("creates client factory pre-configured from LocalConfig", () => {
      const config = {
        ...DEFAULT_LOCAL_CONFIG,
        aws: { region: "us-west-2", profile: "my-work-profile" },
      };

      const factory = getClientFactoryFromConfig(config);
      const sts = factory.getSTSClient();
      expect(sts).toBeDefined();

      const overrideFactory = getClientFactoryFromConfig(config, { region: "ap-northeast-1" });
      const stsOverride = overrideFactory.getSTSClient();
      expect(stsOverride).toBeDefined();
    });
  });

  describe("mapAwsError Actionable Error Mapping", () => {
    it("maps IAM AccessDeniedException to ACCESS_DENIED with OperatorPolicy guidance", () => {
      const err = new Error(
        "User: arn:aws:iam::123456789012:user/ant is not authorized to perform: lambda:RunMicrovm on resource: *",
      );
      err.name = "AccessDeniedException";

      const mapped = mapAwsError(err, { region: "us-east-1", action: "RunMicrovm" });

      expect(mapped).toBeInstanceOf(MappedAwsError);
      expect(mapped.code).toBe("ACCESS_DENIED");
      expect(mapped.message).toContain("Access denied");
      expect(mapped.remediation).toContain("OperatorPolicy");
      expect(mapped.toUserMessage()).toContain("What failed:");
      expect(mapped.toUserMessage()).toContain("What to do next:");
    });

    it("maps ServiceQuotaExceededException to QUOTA_EXCEEDED with console tips", () => {
      const err = new Error("The quota for MicroVM memory has been exceeded.");
      err.name = "ServiceQuotaExceededException";

      const mapped = mapAwsError(err, { region: "us-east-1", action: "RunMicrovm" });

      expect(mapped.code).toBe("QUOTA_EXCEEDED");
      expect(mapped.remediation).toContain("Service Quotas console");
    });

    it("maps ExpiredToken to EXPIRED_CREDENTIALS with re-authentication tips", () => {
      const err = new Error("The security token included in the request is invalid or expired");
      err.name = "ExpiredToken";

      const mapped = mapAwsError(err, { region: "us-east-1" });

      expect(mapped.code).toBe("EXPIRED_CREDENTIALS");
      expect(mapped.remediation).toContain("aws sso login");
    });

    it("maps unsupported regions to UNSUPPORTED_REGION with supported region list", () => {
      const err = new Error("Endpoint not found in region eu-south-1");

      const mapped = mapAwsError(err, { region: "eu-south-1" });

      expect(mapped.code).toBe("UNSUPPORTED_REGION");
      expect(mapped.remediation).toContain("us-east-1");
      expect(mapped.remediation).toContain("us-west-2");
    });

    it("maps ResourceNotFoundException to RESOURCE_NOT_FOUND", () => {
      const err = new Error("Stack with id pi-cloud-agents-core does not exist");
      err.name = "ResourceNotFoundException";

      const mapped = mapAwsError(err, {
        region: "us-east-1",
        resource: "pi-cloud-agents-core",
      });

      expect(mapped.code).toBe("RESOURCE_NOT_FOUND");
      expect(mapped.message).toContain("pi-cloud-agents-core");
      expect(mapped.remediation).toContain("/cloud setup");
    });

    it("maps network connectivity failures to NETWORK_ERROR", () => {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:443");

      const mapped = mapAwsError(err, { region: "us-east-1" });

      expect(mapped.code).toBe("NETWORK_ERROR");
      expect(mapped.remediation).toContain("connectivity");
    });

    it("preserves already mapped MappedAwsError instances idempotently", () => {
      const original = new MappedAwsError({
        message: "Custom message",
        code: "CUSTOM_CODE",
        remediation: "Custom step",
      });

      const mapped = mapAwsError(original);
      expect(mapped).toBe(original);
    });
  });
});
