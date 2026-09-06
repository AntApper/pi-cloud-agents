import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
  SecretsManagerClient,
  TagResourceCommand,
  UpdateSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AwsSecretsStore,
  formatGitHubSecretName,
  formatPiAuthSecretName,
  formatRunSecretName,
  isRunScopedSecretName,
} from "../../core/aws/secrets.js";

const smMock = mockClient(SecretsManagerClient);

describe("AWS Secrets Manager Store (T3.4)", () => {
  let store: AwsSecretsStore;
  let client: SecretsManagerClient;

  beforeEach(() => {
    smMock.reset();
    client = new SecretsManagerClient({ region: "us-east-1" });
    store = new AwsSecretsStore({ client });
  });

  describe("Secret Name Formatters", () => {
    it("formats pi-auth secret name correctly", () => {
      expect(formatPiAuthSecretName("dev-stack", "anthropic")).toBe(
        "pi-cloud-agents/dev-stack/pi-auth/anthropic",
      );
    });

    it("formats github token secret name correctly", () => {
      expect(formatGitHubSecretName("prod-stack")).toBe("pi-cloud-agents/prod-stack/github/token");
    });

    it("formats run-scoped secret name correctly", () => {
      expect(formatRunSecretName("dev-stack", "run-123", "github-token")).toBe(
        "pi-cloud-agents/dev-stack/runs/run-123/github-token",
      );
    });

    it("identifies run-scoped secret names accurately", () => {
      expect(isRunScopedSecretName("pi-cloud-agents/dev-stack/runs/run-123/github-token")).toBe(
        true,
      );
      expect(isRunScopedSecretName("pi-cloud-agents/dev-stack/pi-auth/anthropic")).toBe(false);
      expect(isRunScopedSecretName("pi-cloud-agents/dev-stack/github/token")).toBe(false);
      expect(isRunScopedSecretName("pi-cloud-agents/dev-stack/runs/run-123/env/key")).toBe(true);
    });
  });

  describe("putSecret", () => {
    it("creates a new secret on first put with tags and optional KMS key", async () => {
      smMock.on(CreateSecretCommand).resolves({
        ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:pi-cloud-agents/stack/pi-auth/anthropic",
        VersionId: "v1-uuid",
      });

      const res = await store.putSecret(
        "pi-cloud-agents/stack/pi-auth/anthropic",
        JSON.stringify({ apiKey: "sk-ant-test" }),
        {
          kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test-key",
          tags: { "pi-cloud-agents:stack": "stack" },
          description: "Anthropic credentials",
        },
      );

      expect(res.arn).toBeDefined();
      expect(res.versionId).toBe("v1-uuid");

      const createCalls = smMock.commandCalls(CreateSecretCommand);
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]?.args[0].input).toEqual({
        Name: "pi-cloud-agents/stack/pi-auth/anthropic",
        SecretString: JSON.stringify({ apiKey: "sk-ant-test" }),
        KmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test-key",
        Description: "Anthropic credentials",
        Tags: [{ Key: "pi-cloud-agents:stack", Value: "stack" }],
      });
    });

    it("updates existing secret when ResourceExistsException is encountered", async () => {
      smMock.on(CreateSecretCommand).rejects(
        new ResourceExistsException({
          message: "Secret already exists",
          $metadata: {},
        }),
      );

      smMock.on(PutSecretValueCommand).resolves({
        ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:pi-cloud-agents/stack/github/token",
        VersionId: "v2-uuid",
      });
      smMock.on(UpdateSecretCommand).resolves({});
      smMock.on(TagResourceCommand).resolves({});

      const res = await store.putSecret("pi-cloud-agents/stack/github/token", "ghp_testtoken", {
        kmsKeyId: "test-kms",
        tags: { owner: "ant" },
      });

      expect(res.versionId).toBe("v2-uuid");
      expect(smMock.commandCalls(PutSecretValueCommand)).toHaveLength(1);
      expect(smMock.commandCalls(UpdateSecretCommand)).toHaveLength(1);
      expect(smMock.commandCalls(TagResourceCommand)).toHaveLength(1);
    });
  });

  describe("getSecret", () => {
    it("fetches secret string value", async () => {
      smMock.on(GetSecretValueCommand).resolves({
        SecretString: "ghp_secret_val",
      });

      const val = await store.getSecret("pi-cloud-agents/stack/github/token");
      expect(val).toBe("ghp_secret_val");
    });

    it("returns undefined when secret does not exist (ResourceNotFoundException)", async () => {
      smMock.on(GetSecretValueCommand).rejects(
        new ResourceNotFoundException({
          message: "Not found",
          $metadata: {},
        }),
      );

      const val = await store.getSecret("pi-cloud-agents/stack/github/missing");
      expect(val).toBeUndefined();
    });
  });

  describe("secretExists", () => {
    it("returns true for active existing secret", async () => {
      smMock.on(DescribeSecretCommand).resolves({
        Name: "pi-cloud-agents/stack/pi-auth/openai",
      });

      const exists = await store.secretExists("pi-cloud-agents/stack/pi-auth/openai");
      expect(exists).toBe(true);
    });

    it("returns false if secret is marked for deletion", async () => {
      smMock.on(DescribeSecretCommand).resolves({
        Name: "pi-cloud-agents/stack/pi-auth/openai",
        DeletedDate: new Date(),
      });

      const exists = await store.secretExists("pi-cloud-agents/stack/pi-auth/openai");
      expect(exists).toBe(false);
    });

    it("returns false if secret does not exist", async () => {
      smMock.on(DescribeSecretCommand).rejects(
        new ResourceNotFoundException({
          message: "Not found",
          $metadata: {},
        }),
      );

      const exists = await store.secretExists("pi-cloud-agents/stack/pi-auth/missing");
      expect(exists).toBe(false);
    });
  });

  describe("deleteSecret", () => {
    it("uses standard recovery window for stack-level secrets by default", async () => {
      smMock.on(DeleteSecretCommand).resolves({});

      await store.deleteSecret("pi-cloud-agents/stack/github/token");

      const calls = smMock.commandCalls(DeleteSecretCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args[0].input).toEqual({
        SecretId: "pi-cloud-agents/stack/github/token",
        RecoveryWindowInDays: 7,
      });
    });

    it("uses ForceDeleteWithoutRecovery for run-scoped secrets automatically", async () => {
      smMock.on(DeleteSecretCommand).resolves({});

      await store.deleteSecret("pi-cloud-agents/stack/runs/run-999/github-token");

      const calls = smMock.commandCalls(DeleteSecretCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args[0].input).toEqual({
        SecretId: "pi-cloud-agents/stack/runs/run-999/github-token",
        ForceDeleteWithoutRecovery: true,
      });
    });

    it("uses ForceDeleteWithoutRecovery when force=true is passed explicitly", async () => {
      smMock.on(DeleteSecretCommand).resolves({});

      await store.deleteSecret("pi-cloud-agents/stack/pi-auth/anthropic", {
        force: true,
      });

      const calls = smMock.commandCalls(DeleteSecretCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args[0].input).toEqual({
        SecretId: "pi-cloud-agents/stack/pi-auth/anthropic",
        ForceDeleteWithoutRecovery: true,
      });
    });

    it("gracefully ignores ResourceNotFoundException during deletion", async () => {
      smMock.on(DeleteSecretCommand).rejects(
        new ResourceNotFoundException({
          message: "Not found",
          $metadata: {},
        }),
      );

      await expect(store.deleteSecret("pi-cloud-agents/stack/missing")).resolves.not.toThrow();
    });
  });

  describe("listRunScopedSecrets and listStackSecrets", () => {
    it("lists secret names matching runId and never invokes GetSecretValue", async () => {
      smMock
        .on(ListSecretsCommand)
        .resolvesOnce({
          SecretList: [
            {
              Name: "pi-cloud-agents/stack-1/runs/run-42/token",
            },
            {
              Name: "pi-cloud-agents/stack-1/runs/run-42/oauth-secret",
            },
            {
              Name: "pi-cloud-agents/stack-1/runs/run-99/other-secret", // different runId
            },
          ],
          NextToken: "page-2",
        })
        .resolvesOnce({
          SecretList: [
            {
              Name: "pi-cloud-agents/stack-1/runs/run-42/env-key",
            },
            {
              Name: "pi-cloud-agents/stack-1/runs/run-42/deleted-key",
              DeletedDate: new Date(), // marked deleted
            },
          ],
          NextToken: undefined,
        });

      const names = await store.listRunScopedSecrets("stack-1", "run-42");

      expect(names).toEqual([
        "pi-cloud-agents/stack-1/runs/run-42/token",
        "pi-cloud-agents/stack-1/runs/run-42/oauth-secret",
        "pi-cloud-agents/stack-1/runs/run-42/env-key",
      ]);

      // CRITICAL ASSERTION: GetSecretValue was NEVER called during listing
      expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(0);
    });

    it("lists all stack secrets without retrieving secret values", async () => {
      smMock.on(ListSecretsCommand).resolves({
        SecretList: [
          { Name: "pi-cloud-agents/my-stack/pi-auth/anthropic" },
          { Name: "pi-cloud-agents/my-stack/pi-auth/openai" },
          { Name: "pi-cloud-agents/my-stack/github/token" },
        ],
      });

      const names = await store.listStackSecrets("my-stack");
      expect(names).toHaveLength(3);
      expect(names).toContain("pi-cloud-agents/my-stack/github/token");

      // CRITICAL ASSERTION: GetSecretValue was NEVER called during listing
      expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(0);
    });
  });
});
