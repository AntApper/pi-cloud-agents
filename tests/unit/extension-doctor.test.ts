import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { GetMicrovmImageCommand, LambdaMicrovmsClient } from "@aws-sdk/client-lambda-microvms";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveLocalConfig } from "../../extension/config.js";
import { formatDoctorTable, runDoctorDiagnostics } from "../../extension/doctor.js";
import { DEFAULT_LOCAL_CONFIG } from "../../shared/config.js";

describe("/cloud doctor Diagnostic Probe (T4.1a)", () => {
  let stsMock = mockClient(STSClient);
  let cfnMock = mockClient(CloudFormationClient);
  let microvmsMock = mockClient(LambdaMicrovmsClient);
  let tempDir: string;

  beforeEach(() => {
    stsMock = mockClient(STSClient);
    cfnMock = mockClient(CloudFormationClient);
    microvmsMock = mockClient(LambdaMicrovmsClient);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-test-"));
  });

  afterEach(() => {
    stsMock.restore();
    cfnMock.restore();
    microvmsMock.restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports HEALTHY status when config, AWS identity, stack, and image are valid", async () => {
    saveLocalConfig(
      {
        ...DEFAULT_LOCAL_CONFIG,
        stackName: "pi-cloud-agents-core",
        providers: { synced: ["anthropic", "openai"], oauthOptIn: [], bedrockRole: false },
      },
      { customDir: tempDir },
    );

    stsMock.on(GetCallerIdentityCommand).resolves({
      Account: "123456789012",
      Arn: "arn:aws:iam::123456789012:user/developer",
      UserId: "AIDACKCEVSQ6C2EXAMPLE",
    });

    cfnMock.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackName: "pi-cloud-agents-core",
          StackStatus: "CREATE_COMPLETE",
          CreationTime: new Date(),
        },
      ],
    });

    microvmsMock.on(GetMicrovmImageCommand).resolves({
      imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner",
      state: "CREATED",
      latestActiveImageVersion: "1.0",
    });

    const report = await runDoctorDiagnostics({
      configDir: tempDir,
      region: "us-east-1",
      customClients: {
        stsClient: stsMock as unknown as STSClient,
        cfnClient: cfnMock as unknown as CloudFormationClient,
        microvmsClient: microvmsMock as unknown as LambdaMicrovmsClient,
      },
    });

    expect(report.verdict).toBe("HEALTHY");
    expect(report.checks.find((c) => c.id === "config")?.status).toBe("PASS");
    expect(report.checks.find((c) => c.id === "aws_identity")?.status).toBe("PASS");
    expect(report.checks.find((c) => c.id === "region_support")?.status).toBe("PASS");
    expect(report.checks.find((c) => c.id === "core_stack")?.status).toBe("PASS");
    expect(report.checks.find((c) => c.id === "image_status")?.status).toBe("PASS");
    expect(report.checks.find((c) => c.id === "pi_version")?.status).toBe("PASS");
    expect(report.checks.find((c) => c.id === "synced_providers")?.status).toBe("PASS");

    const table = formatDoctorTable(report);
    expect(table).toContain("pi cloud agents · Doctor Diagnostics");
    expect(table).toContain("● HEALTHY");
    expect(table).toContain("✓ PASS");
  });

  it("reports DEGRADED when config is missing or stack is unprovisioned", async () => {
    stsMock.on(GetCallerIdentityCommand).resolves({
      Account: "123456789012",
      Arn: "arn:aws:iam::123456789012:user/developer",
    });

    cfnMock
      .on(DescribeStacksCommand)
      .rejects(new Error("Stack with id pi-cloud-agents-core does not exist"));
    microvmsMock.on(GetMicrovmImageCommand).rejects(new Error("ResourceNotFoundException"));

    const report = await runDoctorDiagnostics({
      configDir: tempDir, // No config written
      region: "us-east-1",
      customClients: {
        stsClient: stsMock as unknown as STSClient,
        cfnClient: cfnMock as unknown as CloudFormationClient,
        microvmsClient: microvmsMock as unknown as LambdaMicrovmsClient,
      },
    });

    expect(report.verdict).toBe("DEGRADED");
    expect(report.checks.find((c) => c.id === "config")?.status).toBe("WARN");
    expect(report.checks.find((c) => c.id === "core_stack")?.status).toBe("WARN");

    const table = formatDoctorTable(report);
    expect(table).toContain("▲ DEGRADED");
    expect(table).toContain("Remediations");
  });

  it("reports BROKEN when AWS credentials fail STS probe", async () => {
    stsMock
      .on(GetCallerIdentityCommand)
      .rejects(new Error("The security token included in the request is invalid."));

    const report = await runDoctorDiagnostics({
      configDir: tempDir,
      region: "us-east-1",
      customClients: {
        stsClient: stsMock as unknown as STSClient,
        cfnClient: cfnMock as unknown as CloudFormationClient,
        microvmsClient: microvmsMock as unknown as LambdaMicrovmsClient,
      },
    });

    expect(report.verdict).toBe("BROKEN");
    expect(report.checks.find((c) => c.id === "aws_identity")?.status).toBe("FAIL");

    const table = formatDoctorTable(report);
    expect(table).toContain("✗ BROKEN");
    expect(table).toContain("✗ FAIL");
  });
});
