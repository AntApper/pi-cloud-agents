import { describe, expect, it } from "vitest";
import {
  calculateSmokeCost,
  formatInfraSmokeReport,
  runInfraSmoke,
  runSimulatedInfraSmoke,
} from "../../core/aws/infra-smoke.js";

describe("Gate G3: Live Infrastructure Smoke Test Suite", () => {
  it("calculates estimated AWS smoke cost correctly based on measured duration", () => {
    const costShort = calculateSmokeCost(10000, 2); // 10s
    expect(costShort).toBeGreaterThan(0);
    expect(costShort).toBeLessThan(1.0);

    const costLong = calculateSmokeCost(120000, 4); // 2m
    expect(costLong).toBeGreaterThan(costShort);
  });

  it("executes simulated G3 infra smoke run and verifies all 11 steps pass", async () => {
    const report = await runSimulatedInfraSmoke("us-east-1");

    expect(report.overallStatus).toBe("PASS");
    expect(report.mode).toBe("SIMULATED");
    expect(report.verifications.coreStackDeployed.status).toBe("PASS");
    expect(report.verifications.artifactsUploaded.status).toBe("PASS");
    expect(report.verifications.imageStackDeployed.status).toBe("PASS");
    expect(report.verifications.secretsProvisioned.status).toBe("PASS");
    expect(report.verifications.microvmReady.status).toBe("PASS");
    expect(report.verifications.promptExecuted.status).toBe("PASS");
    expect(report.verifications.controllerIdleSuspend.status).toBe("PASS");
    expect(report.verifications.autoResume.status).toBe("PASS");
    expect(report.verifications.terminationAndSummary.status).toBe("PASS");
    expect(report.verifications.stacksDestroyed.status).toBe("PASS");
    expect(report.verifications.cleanupVerification.status).toBe("PASS");

    expect(report.steps.length).toBeGreaterThanOrEqual(11);
    expect(report.errors).toHaveLength(0);

    const formatted = formatInfraSmokeReport(report);
    expect(formatted).toContain("Gate G3: Live Infra Smoke");
    expect(formatted).toContain("Verdict: SUCCESS");
    expect(formatted).toContain("✓ PASS");
    expect(formatted).not.toContain("✗ FAIL");
  });

  it("handles environment-gated live execution gracefully", async () => {
    const isLive = process.env.PI_CLOUD_E2E === "1";
    const report = await runInfraSmoke({
      region: "us-east-1",
      simulate: !isLive,
    });

    expect(report.overallStatus).toBe("PASS");
  });
});
