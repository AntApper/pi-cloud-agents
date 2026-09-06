import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
} from "@aws-sdk/client-cloudformation";
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  NoSuchBucket,
  S3Client,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { StackDeployError, StackDeployer, type StackEventInfo } from "../../core/aws/stack.js";

const cfnMock = mockClient(CloudFormationClient);
const s3Mock = mockClient(S3Client);

describe("CloudFormation Stack Deployer (T3.2)", () => {
  let deployer: StackDeployer;

  beforeEach(() => {
    cfnMock.reset();
    s3Mock.reset();
    deployer = new StackDeployer({
      cfnClient: new CloudFormationClient({ region: "us-east-1" }),
      s3Client: new S3Client({ region: "us-east-1" }),
    });
  });

  describe("deployStack", () => {
    it("creates a new stack via change set when stack does not exist (CREATE path)", async () => {
      // DescribeStacks initially returns not found
      cfnMock
        .on(DescribeStacksCommand, { StackName: "test-stack" })
        .rejectsOnce({
          name: "ValidationError",
          message: "Stack with id test-stack does not exist",
        })
        .resolves({
          Stacks: [
            {
              StackName: "test-stack",
              StackStatus: "CREATE_COMPLETE",
              CreationTime: new Date(),
              Outputs: [
                { OutputKey: "BucketName", OutputValue: "test-bucket" },
                { OutputKey: "RoleArn", OutputValue: "arn:aws:iam::role/test" },
              ],
            },
          ],
        });

      cfnMock.on(CreateChangeSetCommand).resolves({
        Id: "arn:aws:cloudformation:us-east-1:123:changeSet/cs-1",
      });

      cfnMock.on(DescribeChangeSetCommand).resolves({
        Status: "CREATE_COMPLETE",
      });

      cfnMock.on(ExecuteChangeSetCommand).resolves({});

      cfnMock.on(DescribeStackEventsCommand).resolves({
        StackEvents: [
          {
            StackId: "arn:aws:cloudformation:us-east-1:123:stack/test-stack/1",
            StackName: "test-stack",
            EventId: "ev-1",
            LogicalResourceId: "test-stack",
            ResourceType: "AWS::CloudFormation::Stack",
            ResourceStatus: "CREATE_IN_PROGRESS",
            Timestamp: new Date(Date.now() - 2000),
          },
          {
            StackId: "arn:aws:cloudformation:us-east-1:123:stack/test-stack/1",
            StackName: "test-stack",
            EventId: "ev-2",
            LogicalResourceId: "ArtifactBucket",
            ResourceType: "AWS::S3::Bucket",
            ResourceStatus: "CREATE_COMPLETE",
            Timestamp: new Date(),
          },
        ],
      });

      const progressEvents: StackEventInfo[] = [];
      const result = await deployer.deployStack({
        name: "test-stack",
        templateBody: "AWSTemplateFormatVersion: '2010-09-09'...",
        parameters: { ImageName: "runner" },
        tags: { env: "test" },
        pollIntervalMs: 5,
        onProgress: (ev) => progressEvents.push(ev),
      });

      expect(result.status).toBe("CREATE_COMPLETE");
      expect(result.outputs).toEqual({
        BucketName: "test-bucket",
        RoleArn: "arn:aws:iam::role/test",
      });

      // Verify ChangeSetType was CREATE
      const createCsCall = cfnMock.commandCalls(CreateChangeSetCommand)[0];
      expect(createCsCall?.args[0].input.ChangeSetType).toBe("CREATE");
      expect(createCsCall?.args[0].input.Parameters).toEqual([
        { ParameterKey: "ImageName", ParameterValue: "runner" },
      ]);
      expect(createCsCall?.args[0].input.Tags).toEqual([{ Key: "env", Value: "test" }]);

      expect(progressEvents).toHaveLength(2);
      expect(progressEvents[0]?.logicalResourceId).toBe("test-stack");
      expect(progressEvents[1]?.logicalResourceId).toBe("ArtifactBucket");
    });

    it("updates an existing stack via change set (UPDATE path)", async () => {
      // DescribeStacks initially returns existing stack
      cfnMock
        .on(DescribeStacksCommand, { StackName: "existing-stack" })
        .resolvesOnce({
          Stacks: [
            {
              StackName: "existing-stack",
              StackStatus: "UPDATE_COMPLETE",
              CreationTime: new Date(),
            },
          ],
        })
        .resolves({
          Stacks: [
            {
              StackName: "existing-stack",
              StackStatus: "UPDATE_COMPLETE",
              CreationTime: new Date(),
              Outputs: [{ OutputKey: "ImageArn", OutputValue: "arn:image:1" }],
            },
          ],
        });

      cfnMock.on(CreateChangeSetCommand).resolves({});
      cfnMock.on(DescribeChangeSetCommand).resolves({
        Status: "CREATE_COMPLETE",
      });
      cfnMock.on(ExecuteChangeSetCommand).resolves({});
      cfnMock.on(DescribeStackEventsCommand).resolves({
        StackEvents: [],
      });

      const result = await deployer.deployStack({
        name: "existing-stack",
        templateBody: "AWSTemplateFormatVersion: '2010-09-09'...",
        pollIntervalMs: 5,
      });

      expect(result.status).toBe("UPDATE_COMPLETE");
      expect(result.outputs.ImageArn).toBe("arn:image:1");

      const createCsCall = cfnMock.commandCalls(CreateChangeSetCommand)[0];
      expect(createCsCall?.args[0].input.ChangeSetType).toBe("UPDATE");
    });

    it("handles NO_CHANGES change set gracefully as a successful no-op", async () => {
      cfnMock.on(DescribeStacksCommand, { StackName: "unchanged-stack" }).resolves({
        Stacks: [
          {
            StackName: "unchanged-stack",
            StackStatus: "UPDATE_COMPLETE",
            CreationTime: new Date(),
            Outputs: [{ OutputKey: "Bucket", OutputValue: "existing-bucket" }],
          },
        ],
      });

      cfnMock.on(CreateChangeSetCommand).resolves({});
      cfnMock.on(DescribeChangeSetCommand).resolves({
        Status: "FAILED",
        StatusReason:
          "The submitted information didn't contain changes. Submit different information to create a change set.",
      });
      cfnMock.on(DeleteChangeSetCommand).resolves({});

      const result = await deployer.deployStack({
        name: "unchanged-stack",
        templateBody: "...",
        pollIntervalMs: 5,
      });

      expect(result.status).toBe("NO_CHANGES");
      expect(result.outputs.Bucket).toBe("existing-bucket");

      // Verify change set was deleted
      expect(cfnMock.commandCalls(DeleteChangeSetCommand)).toHaveLength(1);
      // Verify execute was NEVER called
      expect(cfnMock.commandCalls(ExecuteChangeSetCommand)).toHaveLength(0);
    });

    it("throws StackDeployError when change set fails with a real error", async () => {
      cfnMock.on(DescribeStacksCommand).resolves({
        Stacks: [
          {
            StackName: "bad-stack",
            StackStatus: "CREATE_COMPLETE",
            CreationTime: new Date(),
          },
        ],
      });
      cfnMock.on(CreateChangeSetCommand).resolves({});
      cfnMock.on(DescribeChangeSetCommand).resolves({
        Status: "FAILED",
        StatusReason: "Template format error: Unresolved resource reference",
      });
      cfnMock.on(DeleteChangeSetCommand).resolves({});

      await expect(
        deployer.deployStack({
          name: "bad-stack",
          templateBody: "invalid",
          pollIntervalMs: 5,
        }),
      ).rejects.toThrow(/Change set creation failed for stack 'bad-stack': Template format error/);

      expect(cfnMock.commandCalls(DeleteChangeSetCommand)).toHaveLength(1);
    });

    it("gathers detailed failure reasons from stack events upon rollback/failure", async () => {
      cfnMock
        .on(DescribeStacksCommand, { StackName: "failing-stack" })
        .resolvesOnce({
          Stacks: [
            {
              StackName: "failing-stack",
              StackStatus: "CREATE_IN_PROGRESS",
              CreationTime: new Date(),
            },
          ],
        })
        .resolves({
          Stacks: [
            {
              StackName: "failing-stack",
              StackStatus: "ROLLBACK_COMPLETE",
              CreationTime: new Date(),
            },
          ],
        });

      cfnMock.on(CreateChangeSetCommand).resolves({});
      cfnMock.on(DescribeChangeSetCommand).resolves({
        Status: "CREATE_COMPLETE",
      });
      cfnMock.on(ExecuteChangeSetCommand).resolves({});

      cfnMock.on(DescribeStackEventsCommand).resolves({
        StackEvents: [
          {
            StackId: "arn:aws:cloudformation:us-east-1:123:stack/failing-stack/1",
            StackName: "failing-stack",
            EventId: "ev-fail-1",
            LogicalResourceId: "MicrovmImage",
            ResourceType: "AWS::Lambda::MicrovmImage",
            ResourceStatus: "CREATE_FAILED",
            ResourceStatusReason: "Build role does not have s3:GetObject permission on runner zip",
            Timestamp: new Date(),
          },
          {
            StackId: "arn:aws:cloudformation:us-east-1:123:stack/failing-stack/1",
            StackName: "failing-stack",
            EventId: "ev-fail-2",
            LogicalResourceId: "failing-stack",
            ResourceType: "AWS::CloudFormation::Stack",
            ResourceStatus: "ROLLBACK_IN_PROGRESS",
            ResourceStatusReason: "The following resource(s) failed to create: [MicrovmImage]",
            Timestamp: new Date(),
          },
        ],
      });

      try {
        await deployer.deployStack({
          name: "failing-stack",
          templateBody: "...",
          pollIntervalMs: 5,
        });
        expect.unreachable("Should have thrown StackDeployError");
      } catch (err) {
        expect(err).toBeInstanceOf(StackDeployError);
        const deployErr = err as StackDeployError;
        expect(deployErr.status).toBe("ROLLBACK_COMPLETE");
        expect(deployErr.failureReasons.length).toBeGreaterThan(0);
        expect(deployErr.message).toContain("Build role does not have s3:GetObject");
      }
    });
  });

  describe("getStackOutputs and stackExists", () => {
    it("returns output dictionary correctly", async () => {
      cfnMock.on(DescribeStacksCommand).resolves({
        Stacks: [
          {
            StackName: "my-stack",
            StackStatus: "CREATE_COMPLETE",
            CreationTime: new Date(),
            Outputs: [
              { OutputKey: "Key1", OutputValue: "Val1" },
              { OutputKey: "Key2", OutputValue: "Val2" },
            ],
          },
        ],
      });

      const outputs = await deployer.getStackOutputs("my-stack");
      expect(outputs).toEqual({ Key1: "Val1", Key2: "Val2" });

      const exists = await deployer.stackExists("my-stack");
      expect(exists).toBe(true);
    });

    it("returns empty outputs and false existence when stack is DELETE_COMPLETE or missing", async () => {
      cfnMock.on(DescribeStacksCommand).resolves({
        Stacks: [
          {
            StackName: "deleted-stack",
            StackStatus: "DELETE_COMPLETE",
            CreationTime: new Date(),
          },
        ],
      });

      expect(await deployer.getStackOutputs("deleted-stack")).toEqual({});
      expect(await deployer.stackExists("deleted-stack")).toBe(false);

      cfnMock.on(DescribeStacksCommand).rejects({
        name: "ValidationError",
        message: "Stack missing does not exist",
      });

      expect(await deployer.getStackOutputs("missing")).toEqual({});
      expect(await deployer.stackExists("missing")).toBe(false);
    });
  });

  describe("deleteStack", () => {
    it("deletes an existing stack and streams progress until complete", async () => {
      cfnMock
        .on(DescribeStacksCommand, { StackName: "to-delete" })
        .resolvesOnce({
          Stacks: [
            {
              StackName: "to-delete",
              StackStatus: "CREATE_COMPLETE",
              CreationTime: new Date(),
            },
          ],
        })
        .resolvesOnce({
          Stacks: [
            {
              StackName: "to-delete",
              StackStatus: "DELETE_IN_PROGRESS",
              CreationTime: new Date(),
            },
          ],
        })
        .resolvesOnce({
          Stacks: [
            {
              StackName: "to-delete",
              StackStatus: "DELETE_COMPLETE",
              CreationTime: new Date(),
            },
          ],
        });

      cfnMock.on(DeleteStackCommand).resolves({});
      cfnMock.on(DescribeStackEventsCommand).resolves({
        StackEvents: [
          {
            StackId: "arn:aws:cloudformation:us-east-1:123:stack/to-delete/1",
            StackName: "to-delete",
            EventId: "ev-del-1",
            LogicalResourceId: "to-delete",
            ResourceType: "AWS::CloudFormation::Stack",
            ResourceStatus: "DELETE_IN_PROGRESS",
            Timestamp: new Date(),
          },
        ],
      });

      const events: StackEventInfo[] = [];
      await deployer.deleteStack("to-delete", {
        pollIntervalMs: 5,
        onProgress: (ev) => events.push(ev),
      });

      expect(cfnMock.commandCalls(DeleteStackCommand)).toHaveLength(1);
      expect(events).toHaveLength(1);
    });

    it("does nothing when stack does not exist", async () => {
      cfnMock.on(DescribeStacksCommand).rejects({
        name: "ValidationError",
        message: "Stack does not exist",
      });

      await deployer.deleteStack("nonexistent");
      expect(cfnMock.commandCalls(DeleteStackCommand)).toHaveLength(0);
    });
  });

  describe("emptyBucket", () => {
    it("deletes all versions and delete markers across multiple pages", async () => {
      s3Mock
        .on(ListObjectVersionsCommand, { Bucket: "my-bucket" })
        .resolvesOnce({
          Versions: [
            { Key: "runs/1/manifest.json", VersionId: "v1" },
            { Key: "runs/1/session.jsonl", VersionId: "v2" },
          ],
          DeleteMarkers: [{ Key: "runs/1/old.json", VersionId: "dm1" }],
          IsTruncated: true,
          NextKeyMarker: "k2",
          NextVersionIdMarker: "vid2",
        })
        .resolvesOnce({
          Versions: [{ Key: "config/bundle.tar", VersionId: "v3" }],
          DeleteMarkers: [],
          IsTruncated: false,
        });

      s3Mock.on(DeleteObjectsCommand).resolves({});

      await deployer.emptyBucket("my-bucket");

      const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
      expect(deleteCalls).toHaveLength(2);

      expect(deleteCalls[0]?.args[0].input.Delete?.Objects).toEqual([
        { Key: "runs/1/manifest.json", VersionId: "v1" },
        { Key: "runs/1/session.jsonl", VersionId: "v2" },
        { Key: "runs/1/old.json", VersionId: "dm1" },
      ]);

      expect(deleteCalls[1]?.args[0].input.Delete?.Objects).toEqual([
        { Key: "config/bundle.tar", VersionId: "v3" },
      ]);
    });

    it("gracefully ignores NoSuchBucket when bucket does not exist", async () => {
      s3Mock.on(ListObjectVersionsCommand).rejects(
        new NoSuchBucket({
          message: "The specified bucket does not exist",
          $metadata: {},
        }),
      );

      await expect(deployer.emptyBucket("ghost-bucket")).resolves.not.toThrow();
    });
  });
});
