/**
 * Unit tests for Guest Capabilities and Controller-Driven Idle Handling spike (T0.4).
 * Tests payload boundaries, outbound DNS/HTTPS reachability probe, in-guest diagnostics,
 * keepalive simulation, post-resume socket teardown, shell WS ingress, and end-to-end report.
 */

import { describe, expect, it } from "vitest";
import {
  calculateGuestCapsEstimatedCost,
  connectWsEchoTest,
  createMockGuestCapsServer,
  formatGuestCapabilitiesReport,
  probeOutboundTargets,
  probePayloadBoundaries,
  runGuestCapabilitiesSpike,
} from "../../core/aws/guest-capabilities.js";

describe("Payload Size Boundaries & ADR-5 Budget", () => {
  it("validates test payload sizes against schema constraint and budget", () => {
    const limits = probePayloadBoundaries();

    expect(limits.safeBudgetThresholdBytes).toBe(3584);
    expect(limits.schemaConstraintBytes).toBe(4096);
    expect(limits.proseLimitBytes).toBe(16384);
    expect(limits.testedSizes).toHaveLength(5);

    // 3.5 KB (3,584 B) must pass and be within constraint
    const size3584 = limits.testedSizes.find((s) => s.sizeBytes === 3584);
    expect(size3584).toBeDefined();
    expect(size3584?.status).toBe("PASS");
    expect(size3584?.parsedCorrectly).toBe(true);
    expect(size3584?.withinSchemaConstraint).toBe(true);

    // 4.0 KB (4,096 B) must pass and be at schema constraint boundary
    const size4096 = limits.testedSizes.find((s) => s.sizeBytes === 4096);
    expect(size4096).toBeDefined();
    expect(size4096?.status).toBe("PASS");
    expect(size4096?.withinSchemaConstraint).toBe(true);

    // 16.0 KB must parse correctly but exceed the 4,096 byte constraint
    const size16384 = limits.testedSizes.find((s) => s.sizeBytes === 16384);
    expect(size16384).toBeDefined();
    expect(size16384?.parsedCorrectly).toBe(true);
    expect(size16384?.withinSchemaConstraint).toBe(false);
  });
});

describe("Outbound Reachability Prober", () => {
  it("probes required outbound endpoints for Anthropic, OpenAI, GitHub, npm, Bedrock", async () => {
    const targets = await probeOutboundTargets("us-east-1");

    expect(targets).toHaveLength(5);
    const names = targets.map((t) => t.name);
    expect(names).toContain("Anthropic API");
    expect(names).toContain("OpenAI API");
    expect(names).toContain("GitHub");
    expect(names).toContain("npm Registry");
    expect(names).toContain("Amazon Bedrock Runtime");

    for (const t of targets) {
      expect(t.dnsResolved).toBe(true);
      expect(t.dnsLatencyMs).toBeGreaterThanOrEqual(0);
      expect(t.httpsConnected || t.statusCode > 0).toBe(true);
    }
  });
});

describe("Mock Guest Capabilities Server & Diag Probes", () => {
  it("handles /diag with full checklist items (a)–(k)", async () => {
    const validToken = "test-token-guest-caps-123";
    const validShellToken = "test-shell-token-guest-caps-456";
    const server = await createMockGuestCapsServer({
      microvmId: "mvm-test-caps-1",
      runHookPayload: JSON.stringify({ test: "caps", runId: "r-1" }),
      validToken,
      validShellToken,
      region: "us-east-1",
    });

    try {
      const port = server.port;

      // 1. Unauthenticated request -> 401
      const resUnauth = await fetch(`http://127.0.0.1:${port}/diag`);
      expect(resUnauth.status).toBe(401);

      // 2. Port 9000 access via proxy -> 403 Forbidden
      const resPortIso = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { "X-aws-proxy-auth": validToken, "X-aws-proxy-port": "9000" },
      });
      expect(resPortIso.status).toBe(403);

      // 3. /diag probe with valid token
      const resDiag = await fetch(`http://127.0.0.1:${port}/diag`, {
        headers: { "X-aws-proxy-auth": validToken, "X-aws-proxy-port": "8080" },
      });
      expect(resDiag.status).toBe(200);

      const diag = (await resDiag.json()) as {
        status: string;
        microvmId: string;
        imdsv2: {
          tokenFetched: boolean;
          credentialsResolved: boolean;
          childProcessResolved: boolean;
        };
        egress: Array<{ host: string }>;
        payload: { parsedCorrectly: boolean };
        hooks: { deliveryPort: number };
        asyncWorker: { active: boolean };
        system: {
          arch: string;
          freeDiskGb: number;
          ptmxAvailable: boolean;
        };
      };
      expect(diag.status).toBe("ok");
      expect(diag.microvmId).toBe("mvm-test-caps-1");
      expect(diag.imdsv2.tokenFetched).toBe(true);
      expect(diag.imdsv2.credentialsResolved).toBe(true);
      expect(diag.imdsv2.childProcessResolved).toBe(true);
      expect(diag.egress.length).toBe(5);
      expect(diag.payload.parsedCorrectly).toBe(true);
      expect(diag.hooks.deliveryPort).toBe(9000);
      expect(diag.asyncWorker.active).toBe(true);
      expect(diag.system.arch).toBeDefined();
      expect(diag.system.freeDiskGb).toBeGreaterThan(0);
      expect(diag.system.ptmxAvailable).toBe(true);

      // 4. /v1/status Keepalive increment
      const resStatus1 = await fetch(`http://127.0.0.1:${port}/v1/status`, {
        headers: { "X-aws-proxy-auth": validToken, "X-aws-proxy-port": "8080" },
      });
      const st1 = (await resStatus1.json()) as { keepaliveCount: number };
      expect(st1.keepaliveCount).toBe(1);

      const resStatus2 = await fetch(`http://127.0.0.1:${port}/v1/status`, {
        headers: { "X-aws-proxy-auth": validToken, "X-aws-proxy-port": "8080" },
      });
      const st2 = (await resStatus2.json()) as { keepaliveCount: number };
      expect(st2.keepaliveCount).toBe(2);

      // 5. Socket teardown lifecycle probe
      await fetch(`http://127.0.0.1:${port}/socket-teardown/init`, {
        method: "POST",
        headers: { "X-aws-proxy-auth": validToken, "X-aws-proxy-port": "8080" },
      });

      const resVerify = await fetch(`http://127.0.0.1:${port}/socket-teardown/verify`, {
        headers: { "X-aws-proxy-auth": validToken, "X-aws-proxy-port": "8080" },
      });
      const verifyData = (await resVerify.json()) as { freshRequestSucceeded: boolean };
      expect(verifyData.freshRequestSucceeded).toBe(true);

      // 6. Shell WebSocket connection on port 8022
      const wsResult = await connectWsEchoTest({
        url: `ws://127.0.0.1:${port}/shell`,
        authToken: validShellToken,
        port: "8022",
        framesToSend: 3,
      });
      expect(wsResult.success).toBe(true);
      expect(wsResult.framesReceived).toBe(3);
    } finally {
      await server.close();
    }
  });
});

describe("End-to-End Guest Capabilities Spike Simulation (T0.4)", () => {
  it("executes simulated T0.4 spike and verifies all checklist items (a)–(k) pass", async () => {
    const report = await runGuestCapabilitiesSpike({
      region: "us-east-1",
      simulate: true,
    });

    expect(report.mode).toBe("SIMULATED");
    expect(report.region).toBe("us-east-1");
    expect(report.overallStatus).toBe("PASS");

    const c = report.checklist;
    expect(c.a_imdsv2_credentials.status).toBe("PASS");
    expect(c.b_outbound_https.status).toBe("PASS");
    expect(c.c_payload_limits.status).toBe("PASS");
    expect(c.d_hook_delivery_port.status).toBe("PASS");
    expect(c.e_async_continuation.status).toBe("PASS");
    expect(c.f_external_keepalive_idle.status).toBe("PASS");
    expect(c.g_external_suspend_resume.status).toBe("PASS");
    expect(c.h_post_resume_behavior.status).toBe("PASS");
    expect(c.i_system_metrics.status).toBe("PASS");
    expect(c.j_shell_ingress.status).toBe("PASS");
    expect(c.k_self_activity_probe.status).toBe("PASS");

    expect(report.cleanup.status).toBe("PASS");
    expect(report.cleanup.cleanedResources.length).toBeGreaterThan(0);
    expect(report.estimatedCostUsd).toBeGreaterThan(0);

    // Verify table formatting
    const table = formatGuestCapabilitiesReport(report);
    expect(table).toContain("Guest Capabilities Spike (T0.4)");
    expect(table).toContain("(a) IMDSv2 Credentials");
    expect(table).toContain("(b) Outbound HTTPS");
    expect(table).toContain("(c) Run-hook Payload Limits");
    expect(table).toContain("(d) Hook Delivery Port");
    expect(table).toContain("(e) Async Post-run Continuation");
    expect(table).toContain("(f) External Keepalive & Idle Suspend");
    expect(table).toContain("(g) External Suspend & Resume Hooks");
    expect(table).toContain("(h) Post-resume Behavior");
    expect(table).toContain("(i) System & Guest Metrics");
    expect(table).toContain("(j) Shell Ingress");
    expect(table).toContain("(k) Self-activity Probe & 1-min Controller Cadence");
    expect(table).toContain("Verdict: SUCCESS");
    expect(table).toContain("✓ PASS");
  });

  it("calculates accurate cost estimation", () => {
    const cost = calculateGuestCapsEstimatedCost(15000, 2);
    expect(cost).toBeGreaterThan(0.01);
    expect(cost).toBeLessThan(0.05);
  });
});
