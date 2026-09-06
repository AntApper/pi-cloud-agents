import type { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import type { LambdaMicrovmsClient } from "@aws-sdk/client-lambda-microvms";
import type { STSClient } from "@aws-sdk/client-sts";
import { describe, expect, it, vi } from "vitest";
import {
  CLOUD_SUBCOMMANDS,
  formatHelpCatalog,
  getCloudArgumentCompletions,
  routeCloudCommand,
} from "../../extension/router.js";

describe("Extension Router (T4.1a)", () => {
  describe("Subcommand Catalog & Completions", () => {
    it("exports all 20 required subcommands", () => {
      const names = CLOUD_SUBCOMMANDS.map((c) => c.name);
      expect(names).toContain("setup");
      expect(names).toContain("verify");
      expect(names).toContain("doctor");
      expect(names).toContain("new");
      expect(names).toContain("list");
      expect(names).toContain("status");
      expect(names).toContain("attach");
      expect(names).toContain("detach");
      expect(names).toContain("stop");
      expect(names).toContain("suspend");
      expect(names).toContain("resume");
      expect(names).toContain("logs");
      expect(names).toContain("pr");
      expect(names).toContain("shell");
      expect(names).toContain("config");
      expect(names).toContain("sync");
      expect(names).toContain("dashboard");
      expect(names).toContain("update");
      expect(names).toContain("destroy");
      expect(names).toContain("help");
      expect(names.length).toBe(20);
    });

    it("autocompletes subcommand names from prefix", () => {
      const docMatches = getCloudArgumentCompletions("doc");
      expect(docMatches).not.toBeNull();
      expect(docMatches).toHaveLength(1);
      expect(docMatches![0]?.value).toBe("doctor");

      const sMatches = getCloudArgumentCompletions("s");
      expect(sMatches).not.toBeNull();
      const sNames = sMatches!.map((m) => m.value);
      expect(sNames).toContain("setup");
      expect(sNames).toContain("status");
      expect(sNames).toContain("stop");
      expect(sNames).toContain("suspend");
      expect(sNames).toContain("sync");
      expect(sNames).toContain("shell");
    });

    it("autocompletes active run IDs for run-scoped subcommands", () => {
      const runMatches = getCloudArgumentCompletions("status run-", ["run-1234", "run-5678"]);
      expect(runMatches).not.toBeNull();
      expect(runMatches).toHaveLength(2);
      expect(runMatches![0]?.value).toBe("status run-1234");
      expect(runMatches![1]?.value).toBe("status run-5678");
    });

    it("returns null for unknown prefix query with no matches", () => {
      const empty = getCloudArgumentCompletions("xyz12345");
      expect(empty).toBeNull();
    });
  });

  describe("Command Routing & Catalog Rendering", () => {
    it("renders help catalog on empty argument or /cloud help", async () => {
      const notify = vi.fn();
      const ctx = { hasUI: true, ui: { notify } };

      const emptyRes = await routeCloudCommand("", ctx);
      expect(emptyRes.subcommand).toBe("help");
      expect(emptyRes.output).toContain("Command Catalog");
      expect(emptyRes.output).toContain("/cloud doctor");
      expect(notify).toHaveBeenCalled();

      const helpRes = await routeCloudCommand("help", ctx);
      expect(helpRes.subcommand).toBe("help");
      expect(helpRes.output).toContain("Command Catalog");
    });

    it("routes /cloud doctor and invokes diagnostic probe", async () => {
      const notify = vi.fn();
      const ctx = { hasUI: true, ui: { notify } };

      const stsMock = {
        send: vi.fn().mockResolvedValue({
          Account: "123456789012",
          Arn: "arn:aws:iam::123456789012:user/dev",
        }),
      };
      const cfnMock = {
        send: vi.fn().mockResolvedValue({
          Stacks: [{ StackName: "pi-cloud-agents-core", StackStatus: "CREATE_COMPLETE" }],
        }),
      };
      const microvmsMock = {
        send: vi.fn().mockResolvedValue({
          imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:pi-cloud-agents-runner",
          state: "CREATED",
          latestActiveImageVersion: "1.0",
        }),
      };

      const res = await routeCloudCommand("doctor", ctx, {
        region: "us-east-1",
        customClients: {
          stsClient: stsMock as unknown as STSClient,
          cfnClient: cfnMock as unknown as CloudFormationClient,
          microvmsClient: microvmsMock as unknown as LambdaMicrovmsClient,
        },
      });
      expect(res.subcommand).toBe("doctor");
      expect(res.output).toContain("Doctor Diagnostics");
      expect(res.handled).toBe(true);
      expect(notify).toHaveBeenCalled();
    });

    it("returns clean stub notice for unimplemented subcommands", async () => {
      const notify = vi.fn();
      const ctx = { hasUI: true, ui: { notify } };

      const res = await routeCloudCommand("dashboard", ctx);
      expect(res.subcommand).toBe("dashboard");
      expect(res.output).toContain("stubbed in T4.1a");
      expect(res.handled).toBe(true);
    });

    it("handles unknown subcommand gracefully", async () => {
      const notify = vi.fn();
      const ctx = { hasUI: true, ui: { notify } };

      const res = await routeCloudCommand("foobar123", ctx);
      expect(res.subcommand).toBe("foobar123");
      expect(res.output).toContain("Unknown cloud command: '/cloud foobar123'");
      expect(res.handled).toBe(false);
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("Unknown cloud command"),
        "error",
      );
    });

    it("formats clean help catalog without forbidden emoji", () => {
      const catalog = formatHelpCatalog();
      expect(catalog).toContain("┌ pi cloud agents · Command Catalog");
      expect(catalog).toContain("/cloud setup");
      expect(catalog).toContain("/cloud verify");
      expect(catalog).toContain("/cloud destroy");
      expect(catalog).not.toMatch(/[\u{1F000}-\u{1FAFF}]/u);
    });
  });
});
