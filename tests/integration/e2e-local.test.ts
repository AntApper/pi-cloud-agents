import { describe, expect, it } from "vitest";
import { runLocalE2eTest } from "../../scripts/e2e-local.js";

describe("T2.8 & Gate G2: Zero-cost Local End-to-End Test Suite", () => {
  it("executes full local run, creates git checkpoint, mirrors session, captures metrics, and passes zero-secrets rule", async () => {
    const report = await runLocalE2eTest({
      hookPort: 9022,
      apiPort: 8092,
      verbose: false,
    });

    expect(report.errors).toHaveLength(0);
    expect(report.verdict).toBe("PASS");
    expect(report.checks.harnessStartup).toBe(true);
    expect(report.checks.clientTurn).toBe(true);
    expect(report.checks.manifestTransitions).toBe(true);
    expect(report.checks.sessionMirrored).toBe(true);
    expect(report.checks.gitCheckpointCreated).toBe(true);
    expect(report.checks.fileContentVerified).toBe(true);
    expect(report.checks.metricsCaptured).toBe(true);
    expect(report.checks.zeroSecretsPlaintext).toBe(true);
  }, 60000);
});
