import { describe, expect, it } from "vitest";
import { maskAccountId, maskArn, maskObject, maskSecrets } from "../../core/aws/mask.js";

describe("mask utilities", () => {
  it("masks 12-digit AWS account IDs in plain text", () => {
    const input = "User account 123456789012 requested MicroVM creation";
    expect(maskAccountId(input)).toBe("User account <ACCOUNT_ID> requested MicroVM creation");
  });

  it("masks account IDs in IAM and Lambda ARNs", () => {
    const iamArn = "arn:aws:iam::123456789012:user/ant";
    const lambdaArn = "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-test";

    expect(maskArn(iamArn)).toBe("arn:aws:iam::<ACCOUNT_ID>:user/ant");
    expect(maskArn(lambdaArn)).toBe(
      "arn:aws:lambda:us-east-1:<ACCOUNT_ID>:microvm-image:pi-cloud-test",
    );
  });

  it("does not mask numbers that are not 12 digits", () => {
    const text = "Port 8080 with 2048 MB memory and timestamp 1741369200";
    expect(maskAccountId(text)).toBe(text);
  });

  it("masks registered secrets", () => {
    const text = "Bearer sk-proj-supersecretkey1234567890 with account 123456789012";
    const masked = maskSecrets(text, ["sk-proj-supersecretkey1234567890"]);
    expect(masked).toBe("Bearer [REDACTED] with account <ACCOUNT_ID>");
  });

  it("deeply masks objects, arrays, and Error instances", () => {
    const obj = {
      arn: "arn:aws:iam::123456789012:role/operator",
      tags: ["account:123456789012", "clean"],
      nested: {
        id: "123456789012",
        count: 42,
      },
    };

    const masked = maskObject(obj);
    expect(masked.arn).toBe("arn:aws:iam::<ACCOUNT_ID>:role/operator");
    expect(masked.tags).toEqual(["account:<ACCOUNT_ID>", "clean"]);
    expect(masked.nested.id).toBe("<ACCOUNT_ID>");
    expect(masked.nested.count).toBe(42);

    const err = new Error("Failed for account 123456789012 in stack");
    const maskedErr = maskObject(err);
    expect(maskedErr.message).toBe("Failed for account <ACCOUNT_ID> in stack");
  });
});
