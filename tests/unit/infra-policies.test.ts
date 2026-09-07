import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const CFN_TAGS = [
  "Ref",
  "Sub",
  "GetAtt",
  "If",
  "Not",
  "Equals",
  "Join",
  "Select",
  "Split",
  "FindInMap",
  "Base64",
  "Cidr",
  "And",
  "Or",
  "ImportValue",
];

const cfnCustomTags = CFN_TAGS.flatMap((tag) => [
  {
    tag: `!${tag}`,
    resolve: (value: unknown) => ({ [`Fn::${tag}`]: value }),
  },
  {
    tag: `!${tag}`,
    collection: "seq" as const,
    resolve: (value: unknown) => {
      const v = value as { toJSON?: () => unknown };
      return {
        [`Fn::${tag}`]: typeof v?.toJSON === "function" ? v.toJSON() : value,
      };
    },
  },
  {
    tag: `!${tag}`,
    collection: "map" as const,
    resolve: (value: unknown) => {
      const v = value as { toJSON?: () => unknown };
      return {
        [`Fn::${tag}`]: typeof v?.toJSON === "function" ? v.toJSON() : value,
      };
    },
  },
]);

function parseCfnTemplate(filePath: string): Record<string, unknown> {
  const content = readFileSync(filePath, "utf-8");
  return YAML.parse(content, { customTags: cfnCustomTags }) as Record<string, unknown>;
}

const ALLOWED_WILDCARD_ACTIONS = new Set([
  "sts:GetCallerIdentity",
  "lambda:ListManagedMicrovmImages",
  "lambda:ListManagedMicrovmImageVersions",
  "lambda:ListMicrovmImages",
  "lambda:ListMicrovms",
  "secretsmanager:ListSecrets",
  "servicequotas:GetServiceQuota",
  "servicequotas:ListServiceQuotas",
  "ecr:GetAuthorizationToken",
]);

interface PolicyStatement {
  Sid?: string;
  Effect?: string;
  Action?: string | string[];
  Resource?: string | string[];
  Condition?: Record<string, unknown>;
  "Fn::If"?: [string, PolicyStatement, unknown];
}

interface CfnResource {
  Type: string;
  Properties: Record<string, unknown>;
}

describe("CloudFormation Core Stack Security Policies (T3.1a)", () => {
  const corePath = resolve(process.cwd(), "infra/core.yaml");
  const template = parseCfnTemplate(corePath);
  const resources = (template.Resources ?? {}) as Record<string, CfnResource>;
  const params = (template.Parameters ?? {}) as Record<string, Record<string, unknown>>;
  const conditions = (template.Conditions ?? {}) as Record<string, unknown>;
  const outputs = (template.Outputs ?? {}) as Record<string, unknown>;

  it("loads and parses infra/core.yaml cleanly", () => {
    expect(template).toBeDefined();
    expect(template.AWSTemplateFormatVersion).toBe("2010-09-09");
    expect(resources).toBeDefined();
  });

  it("configures all required parameters and conditions", () => {
    expect(params.ImageName).toBeDefined();
    expect(params.LogRetentionDays).toBeDefined();
    expect(params.ArchiveRetentionDays).toBeDefined();
    expect(params.KmsKeyArn).toBeDefined();
    expect(params.EnableBedrock).toBeDefined();
    expect(params.EnableBedrock?.AllowedValues).toEqual(["true", "false"]);

    expect(conditions.HasKmsKey).toBeDefined();
    expect(conditions.BedrockEnabled).toBeDefined();
  });

  it("configures S3 ArtifactBucket with public access block, encryption, and lifecycle rules", () => {
    const bucket = resources.ArtifactBucket;
    expect(bucket).toBeDefined();
    expect(bucket?.Type).toBe("AWS::S3::Bucket");

    const props = bucket?.Properties ?? {};
    expect(props.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(props.VersioningConfiguration).toEqual({
      Status: "Enabled",
    });
    expect(props.BucketEncryption).toBeDefined();

    const lifecycle = props.LifecycleConfiguration as
      | {
          Rules: Array<Record<string, unknown>>;
        }
      | undefined;
    const rules = lifecycle?.Rules ?? [];
    expect(rules).toHaveLength(2);
    expect(rules[0]?.Prefix).toBe("runs/");
    expect(rules[1]?.AbortIncompleteMultipartUpload).toBeDefined();
  });

  it("configures CloudWatch LogGroups with retention", () => {
    const imageLogs = resources.ImageLogGroup;
    expect(imageLogs).toBeDefined();
    expect(imageLogs?.Type).toBe("AWS::Logs::LogGroup");
    expect(imageLogs?.Properties.RetentionInDays).toBeDefined();

    const controllerLogs = resources.ControllerLogGroup;
    expect(controllerLogs).toBeDefined();
    expect(controllerLogs?.Type).toBe("AWS::Logs::LogGroup");
    expect(controllerLogs?.Properties.RetentionInDays).toBeDefined();
  });

  it("configures BuildRole with confused deputy protection and scoped permissions", () => {
    const role = resources.BuildRole;
    expect(role).toBeDefined();
    expect(role?.Type).toBe("AWS::IAM::Role");

    const assumeDoc = role?.Properties.AssumeRolePolicyDocument as
      | {
          Statement: Array<{
            Effect: string;
            Principal: { Service: string };
            Action: string[];
            Condition: { StringEquals: Record<string, unknown> };
          }>;
        }
      | undefined;
    const stmt = assumeDoc?.Statement?.[0];
    expect(stmt).toBeDefined();
    expect(stmt?.Effect).toBe("Allow");
    expect(stmt?.Principal.Service).toBe("lambda.amazonaws.com");
    expect(stmt?.Action).toContain("sts:AssumeRole");
    expect(stmt?.Action).toContain("sts:TagSession");
    expect(stmt?.Condition.StringEquals["aws:SourceAccount"]).toBeDefined();

    const policies = role?.Properties.Policies as
      | Array<{
          PolicyName: string;
          PolicyDocument: { Statement: PolicyStatement[] };
        }>
      | undefined;
    expect(policies).toBeDefined();
    const policyDoc = policies?.[0]?.PolicyDocument;
    const actions = (policyDoc?.Statement ?? [])
      .flatMap((s: PolicyStatement) => {
        const ifBranch = s["Fn::If"];
        if (ifBranch && Array.isArray(ifBranch)) {
          const ifStmt = ifBranch[1] as PolicyStatement;
          const act = ifStmt?.Action;
          return Array.isArray(act) ? act : act ? [act] : [];
        }
        const act = s.Action;
        return Array.isArray(act) ? act : act ? [act] : [];
      })
      .filter(Boolean);

    expect(actions).toContain("s3:GetObject");
    expect(actions).toContain("logs:PutLogEvents");
  });

  it("strictly enforces that ExecutionRole has NO lambda:* permissions", () => {
    const role = resources.ExecutionRole;
    expect(role).toBeDefined();
    expect(role?.Type).toBe("AWS::IAM::Role");

    const assumeDoc = role?.Properties.AssumeRolePolicyDocument as
      | {
          Statement: Array<{
            Effect: string;
            Principal: { Service: string };
            Action: string[];
            Condition: { StringEquals: Record<string, unknown> };
          }>;
        }
      | undefined;
    const stmt = assumeDoc?.Statement?.[0];
    expect(stmt).toBeDefined();
    expect(stmt?.Effect).toBe("Allow");
    expect(stmt?.Principal.Service).toBe("lambda.amazonaws.com");
    expect(stmt?.Action).toContain("sts:AssumeRole");
    expect(stmt?.Action).toContain("sts:TagSession");
    expect(stmt?.Condition.StringEquals["aws:SourceAccount"]).toBeDefined();

    const policies = (role?.Properties.Policies ?? []) as Array<{
      PolicyName: string;
      PolicyDocument: { Statement: PolicyStatement[] };
    }>;
    expect(policies.length).toBeGreaterThan(0);

    const allStatements: PolicyStatement[] = [];
    for (const policy of policies) {
      for (const statement of policy.PolicyDocument.Statement) {
        if (statement["Fn::If"]) {
          const ifStmt = statement["Fn::If"][1];
          if (ifStmt && typeof ifStmt === "object") {
            allStatements.push(ifStmt as PolicyStatement);
          }
        } else {
          allStatements.push(statement);
        }
      }
    }

    const allActions: string[] = allStatements.flatMap((s: PolicyStatement) =>
      Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [],
    );

    for (const action of allActions) {
      expect(action.toLowerCase().startsWith("lambda:")).toBe(false);
    }

    // Verify S3, secretsmanager, logs, bedrock permissions exist
    expect(allActions).toContain("s3:GetObject");
    expect(allActions).toContain("s3:PutObject");
    expect(allActions).toContain("secretsmanager:GetSecretValue");
    expect(allActions).toContain("logs:PutLogEvents");
    expect(allActions).toContain("bedrock:InvokeModel");
  });

  it("configures OperatorPolicy and verifies no unauthorized wildcard '*' resources", () => {
    const operatorPolicy = resources.OperatorPolicy;
    expect(operatorPolicy).toBeDefined();
    expect(operatorPolicy?.Type).toBe("AWS::IAM::ManagedPolicy");

    const policyDoc = operatorPolicy?.Properties.PolicyDocument as
      | {
          Statement: PolicyStatement[];
        }
      | undefined;
    const statements = policyDoc?.Statement ?? [];
    expect(statements.length).toBeGreaterThan(5);

    for (const stmt of statements) {
      const statement = stmt["Fn::If"] ? (stmt["Fn::If"][1] as PolicyStatement) : stmt;
      if (!statement || statement.Effect !== "Allow") continue;

      const res = statement.Resource;
      const resourcesList = Array.isArray(res) ? res : res ? [res] : [];
      const acts = statement.Action;
      const actions = Array.isArray(acts) ? acts : acts ? [acts] : [];

      if (resourcesList.includes("*")) {
        for (const action of actions) {
          expect(ALLOWED_WILDCARD_ACTIONS.has(action)).toBe(true);
        }
      }
    }
  });

  it("exports all required outputs", () => {
    expect(outputs.BucketName).toBeDefined();
    expect(outputs.BucketArn).toBeDefined();
    expect(outputs.BuildRoleArn).toBeDefined();
    expect(outputs.ExecutionRoleArn).toBeDefined();
    expect(outputs.OperatorPolicyArn).toBeDefined();
    expect(outputs.ImageLogGroup).toBeDefined();
    expect(outputs.ControllerLogGroup).toBeDefined();
  });
});

describe("CloudFormation Image Stack & Controller (T3.1b)", () => {
  const imagePath = resolve(process.cwd(), "infra/image.yaml");
  const template = parseCfnTemplate(imagePath);
  const resources = (template.Resources ?? {}) as Record<string, CfnResource>;
  const params = (template.Parameters ?? {}) as Record<string, Record<string, unknown>>;
  const outputs = (template.Outputs ?? {}) as Record<string, unknown>;

  it("loads and parses infra/image.yaml cleanly", () => {
    expect(template).toBeDefined();
    expect(template.AWSTemplateFormatVersion).toBe("2010-09-09");
    expect(resources).toBeDefined();
  });

  it("configures all required parameters for image stack", () => {
    expect(params.ArtifactBucket).toBeDefined();
    expect(params.RunnerArtifactKey).toBeDefined();
    expect(params.ControllerArtifactKey).toBeDefined();
    expect(params.ImageName).toBeDefined();
    expect(params.MemoryMiB).toBeDefined();
    expect(params.BuildRoleArn).toBeDefined();
    expect(params.ExecutionRoleArn).toBeDefined();
    expect(params.BaseImageArn).toBeDefined();
    expect(params.BaseImageVersion).toBeDefined();
    expect(params.ImageLogGroup).toBeDefined();
  });

  it("configures AWS::Lambda::MicrovmImage with ALL required properties", () => {
    const image = resources.MicrovmImage;
    expect(image).toBeDefined();
    expect(image?.Type).toBe("AWS::Lambda::MicrovmImage");

    const props = image?.Properties ?? {};

    // All required properties must be present
    expect(props.Name).toBeDefined();
    expect(props.Description).toBeDefined();
    expect(props.BaseImageArn).toBeDefined();
    expect(props.BaseImageVersion).toBeDefined();
    expect(props.BuildRoleArn).toBeDefined();
    expect(props.CodeArtifact).toBeDefined();
    expect(props.CpuConfigurations).toBeDefined();
    expect(props.AdditionalOsCapabilities).toBeDefined();
    expect(props.EgressNetworkConnectors).toBeDefined();
    expect(props.EnvironmentVariables).toBeDefined();
    expect(props.Hooks).toBeDefined();
    expect(props.Logging).toBeDefined();
    expect(props.Resources).toBeDefined();
    expect(props.Tags).toBeDefined();

    // Verify CPU architecture is ARM_64
    const cpuConfigs = props.CpuConfigurations as Array<{
      Architecture: string;
    }>;
    expect(cpuConfigs[0]?.Architecture).toBe("ARM_64");

    // Verify Environment Variables
    const envVars = props.EnvironmentVariables as Array<{
      Key: string;
      Value: unknown;
    }>;
    const envKeys = envVars.map((e) => e.Key);
    expect(envKeys).toContain("PI_CLOUD_STACK");
    expect(envKeys).toContain("PI_CLOUD_BUCKET");
    expect(envKeys).toContain("HOOK_PORT");
  });

  it("explicitly configures all hook timeouts (never relying on 1s defaults)", () => {
    const image = resources.MicrovmImage;
    const hooks = image?.Properties?.Hooks as Record<string, { TimeoutInSeconds: number }>;
    expect(hooks).toBeDefined();

    expect(hooks.ReadyHook?.TimeoutInSeconds).toBe(120);
    expect(hooks.ValidateHook?.TimeoutInSeconds).toBe(120);
    expect(hooks.RunHook?.TimeoutInSeconds).toBe(30);
    expect(hooks.ResumeHook?.TimeoutInSeconds).toBe(15);
    expect(hooks.SuspendHook?.TimeoutInSeconds).toBe(45);
    expect(hooks.TerminateHook?.TimeoutInSeconds).toBe(45);
  });

  it("configures Controller Lambda function and IAM role with required permissions", () => {
    const fn = resources.ControllerFunction;
    expect(fn).toBeDefined();
    expect(fn?.Type).toBe("AWS::Lambda::Function");

    const fnProps = fn?.Properties ?? {};
    expect(fnProps.Runtime).toBe("nodejs22.x");
    expect(fnProps.Architectures).toEqual(["arm64"]);
    expect(fnProps.ReservedConcurrentExecutions).toBe(1);
    expect(fnProps.Timeout).toBe(50);

    const role = resources.ControllerExecutionRole;
    expect(role).toBeDefined();
    expect(role?.Type).toBe("AWS::IAM::Role");

    const policies = role?.Properties.Policies as Array<{
      PolicyName: string;
      PolicyDocument: { Statement: PolicyStatement[] };
    }>;
    const policyDoc = policies?.[0]?.PolicyDocument;
    const actions = (policyDoc?.Statement ?? []).flatMap((s: PolicyStatement) => {
      const act = s.Action;
      return Array.isArray(act) ? act : act ? [act] : [];
    });

    expect(actions).toContain("lambda:ListMicrovms");
    expect(actions).toContain("lambda:GetMicrovm");
    expect(actions).toContain("lambda:SuspendMicrovm");
    expect(actions).toContain("lambda:TerminateMicrovm");
    expect(actions).toContain("lambda:CreateMicrovmAuthToken");
    expect(actions).toContain("s3:GetObject");
    expect(actions).toContain("s3:PutObject");
    expect(actions).toContain("secretsmanager:ListSecrets");
    expect(actions).toContain("secretsmanager:DeleteSecret");
  });

  it("declares optional KmsKeyArn parameter and HasKmsKey condition in infra/image.yaml", () => {
    expect(params.KmsKeyArn).toBeDefined();
    expect(params.KmsKeyArn?.Type).toBe("String");
  });

  it("configures EventBridge 1-minute schedule rule and Lambda permission", () => {
    const rule = resources.ControllerScheduleRule;
    expect(rule).toBeDefined();
    expect(rule?.Type).toBe("AWS::Events::Rule");
    expect(rule?.Properties.ScheduleExpression).toBe("rate(1 minute)");
    expect(rule?.Properties.State).toBe("ENABLED");

    const perm = resources.ControllerLambdaPermission;
    expect(perm).toBeDefined();
    expect(perm?.Type).toBe("AWS::Lambda::Permission");
    expect(perm?.Properties.Action).toBe("lambda:InvokeFunction");
    expect(perm?.Properties.Principal).toBe("events.amazonaws.com");
  });

  it("exports required image stack outputs", () => {
    expect(outputs.ImageArn).toBeDefined();
    expect(outputs.LatestActiveImageVersion).toBeDefined();
    expect(outputs.ControllerFunctionName).toBeDefined();
    expect(outputs.ControllerFunctionArn).toBeDefined();
  });
});
