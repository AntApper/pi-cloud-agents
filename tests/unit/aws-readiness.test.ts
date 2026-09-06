import type { LambdaMicrovmsClient } from "@aws-sdk/client-lambda-microvms";
import type { ServiceQuotasClient } from "@aws-sdk/client-service-quotas";
import type { STSClient } from "@aws-sdk/client-sts";
import { describe, expect, it } from "vitest";
import {
  SUPPORTED_MICROVM_REGIONS,
  formatReadinessTable,
  getDefaultMemoryQuotaGB,
  isMicrovmRegionSupported,
  probeAwsReadiness,
} from "../../core/aws/readiness.js";
import { findForbiddenGlyphs } from "../../scripts/doc-glyph-scan.js";

interface SdkCommandLike {
  constructor?: {
    name?: string;
  };
}

describe("AWS Readiness Probe", () => {
  it("verifies supported MicroVM regions and default quotas", () => {
    expect(SUPPORTED_MICROVM_REGIONS).toContain("us-east-1");
    expect(SUPPORTED_MICROVM_REGIONS).toContain("us-east-2");
    expect(SUPPORTED_MICROVM_REGIONS).toContain("us-west-2");
    expect(SUPPORTED_MICROVM_REGIONS).toContain("ap-northeast-1");
    expect(SUPPORTED_MICROVM_REGIONS).toContain("eu-west-1");

    expect(isMicrovmRegionSupported("us-east-1")).toBe(true);
    expect(isMicrovmRegionSupported("us-west-2")).toBe(true);
    expect(isMicrovmRegionSupported("invalid-region-1")).toBe(false);

    expect(getDefaultMemoryQuotaGB("us-east-1")).toBe(1024);
    expect(getDefaultMemoryQuotaGB("us-east-2")).toBe(1024);
    expect(getDefaultMemoryQuotaGB("eu-west-1")).toBe(400);
  });

  it("handles successful probe with mocked clients", async () => {
    const fakeSts = {
      send: async () => ({
        Account: "123456789012",
        Arn: "arn:aws:iam::123456789012:user/ant",
        UserId: "AIDAI1234567890",
      }),
    } as unknown as STSClient;

    const fakeMicrovms = {
      send: async (cmd: SdkCommandLike) => {
        const cmdName = cmd.constructor?.name;
        if (cmdName === "ListManagedMicrovmImagesCommand") {
          return {
            items: [
              {
                imageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
                createdAt: new Date("2026-06-01T00:00:00Z"),
              },
            ],
          };
        }
        if (cmdName === "ListManagedMicrovmImageVersionsCommand") {
          return {
            items: [
              {
                imageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
                imageVersion: "v12",
                status: "AVAILABLE",
                createdAt: new Date("2026-08-01T00:00:00Z"),
              },
            ],
          };
        }
        if (cmdName === "ListMicrovmImagesCommand") {
          return { items: [] };
        }
        if (cmdName === "ListMicrovmsCommand") {
          return { items: [] };
        }
        return {};
      },
    } as unknown as LambdaMicrovmsClient;

    const fakeQuotas = {
      send: async () => ({
        Quotas: [
          {
            QuotaName: "MicroVM total configured memory",
            Value: 1024,
          },
        ],
      }),
    } as unknown as ServiceQuotasClient;

    const report = await probeAwsReadiness({
      region: "us-east-1",
      stsClient: fakeSts,
      microvmsClient: fakeMicrovms,
      serviceQuotasClient: fakeQuotas,
    });

    expect(report.verdict).toBe("READY");
    expect(report.identity.status).toBe("PASS");
    expect(report.identity.account).toBe("<ACCOUNT_ID>");
    expect(report.identity.arn).toBe("arn:aws:iam::<ACCOUNT_ID>:user/ant");
    expect(report.microvmManagedImages.baseImageArn).toBe(
      "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
    );
    expect(report.microvmManagedImages.baseImageVersion).toBe("v12");
    expect(report.serviceQuota.memoryQuotaGB).toBe(1024);

    const formatted = formatReadinessTable(report);
    expect(formatted).toContain("Verdict: READY");
    expect(formatted).not.toContain("123456789012");
    expect(findForbiddenGlyphs(formatted)).toHaveLength(0);
  });

  it("handles authentication failure gracefully (NOT_CONFIGURED)", async () => {
    const fakeSts = {
      send: async () => {
        throw new Error("The security token included in the request is invalid for 123456789012");
      },
    } as unknown as STSClient;

    const report = await probeAwsReadiness({
      region: "us-east-1",
      stsClient: fakeSts,
    });

    expect(report.verdict).toBe("NOT_CONFIGURED");
    expect(report.identity.status).toBe("FAIL");
    expect(report.identity.error).toContain("<ACCOUNT_ID>");
    expect(report.remediations.length).toBeGreaterThan(0);

    const formatted = formatReadinessTable(report);
    expect(formatted).toContain("NOT_CONFIGURED");
    expect(formatted).not.toContain("123456789012");
    expect(findForbiddenGlyphs(formatted)).toHaveLength(0);
  });

  it("handles MicroVM permission failure gracefully (BLOCKED)", async () => {
    const fakeSts = {
      send: async () => ({
        Account: "123456789012",
        Arn: "arn:aws:iam::123456789012:user/ant",
      }),
    } as unknown as STSClient;

    const fakeMicrovms = {
      send: async () => {
        throw new Error(
          "AccessDeniedException: User is not authorized to perform lambda:ListManagedMicrovmImages",
        );
      },
    } as unknown as LambdaMicrovmsClient;

    const fakeQuotas = {
      send: async () => ({
        Quotas: [],
      }),
    } as unknown as ServiceQuotasClient;

    const report = await probeAwsReadiness({
      region: "us-east-1",
      stsClient: fakeSts,
      microvmsClient: fakeMicrovms,
      serviceQuotasClient: fakeQuotas,
    });

    expect(report.verdict).toBe("BLOCKED");
    expect(report.microvmManagedImages.status).toBe("FAIL");
    expect(report.remediations.some((r) => r.includes("lambda:ListManagedMicrovmImages"))).toBe(
      true,
    );

    const formatted = formatReadinessTable(report);
    expect(formatted).toContain("BLOCKED");
    expect(findForbiddenGlyphs(formatted)).toHaveLength(0);
  });
});
