/**
 * IAM Operator Policy Helper (T4.15).
 * Generates least-privilege operator policy JSON and standalone CloudFormation template,
 * with optional automated IAM creation.
 */

import { CreatePolicyCommand, type IAMClient } from "@aws-sdk/client-iam";

export interface OperatorPolicyOptions {
  region?: string;
  accountId?: string;
  stackName?: string;
  imageName?: string;
}

export const OPERATOR_POLICY_DOCUMENT = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "CloudFormationStackOps",
      Effect: "Allow",
      Action: [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:GetTemplate",
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
      ],
      Resource: [
        "arn:aws:cloudformation:*:*:stack/pi-cloud-agents-*/*",
        "arn:aws:cloudformation:*:*:changeSet/pi-cloud-agents-*/*",
      ],
    },
    {
      Sid: "MicrovmManagement",
      Effect: "Allow",
      Action: [
        "lambda:CreateMicrovmImage",
        "lambda:UpdateMicrovmImage",
        "lambda:GetMicrovmImage",
        "lambda:GetMicrovmImageVersion",
        "lambda:GetMicrovmImageBuild",
        "lambda:ListMicrovmImages",
        "lambda:ListMicrovmImageVersions",
        "lambda:ListMicrovmImageBuilds",
        "lambda:DeleteMicrovmImageVersion",
        "lambda:DeleteMicrovmImage",
        "lambda:RunMicrovm",
        "lambda:GetMicrovm",
        "lambda:ListMicrovms",
        "lambda:SuspendMicrovm",
        "lambda:ResumeMicrovm",
        "lambda:TerminateMicrovm",
        "lambda:CreateMicrovmAuthToken",
        "lambda:CreateMicrovmShellAuthToken",
      ],
      Resource: "*",
    },
    {
      Sid: "PassNetworkConnector",
      Effect: "Allow",
      Action: ["lambda:PassNetworkConnector"],
      Resource: "arn:aws:lambda:*:aws:network-connector:aws-network-connector:*",
    },
    {
      Sid: "SecretsManagerOps",
      Effect: "Allow",
      Action: [
        "secretsmanager:CreateSecret",
        "secretsmanager:PutSecretValue",
        "secretsmanager:GetSecretValue",
        "secretsmanager:DeleteSecret",
        "secretsmanager:DescribeSecret",
        "secretsmanager:ListSecrets",
        "secretsmanager:TagResource",
      ],
      Resource: "arn:aws:secretsmanager:*:*:secret:pi-cloud-agents/*",
    },
    {
      Sid: "S3ArtifactStorage",
      Effect: "Allow",
      Action: [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:PutBucketPublicAccessBlock",
        "s3:PutBucketEncryption",
        "s3:PutBucketLifecycleConfiguration",
        "s3:PutBucketVersioning",
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:ListBucketVersions",
      ],
      Resource: ["arn:aws:s3:::pi-cloud-agents-*", "arn:aws:s3:::pi-cloud-agents-*/*"],
    },
    {
      Sid: "STSAndDiscovery",
      Effect: "Allow",
      Action: [
        "sts:GetCallerIdentity",
        "lambda:ListManagedMicrovmImages",
        "lambda:ListManagedMicrovmImageVersions",
      ],
      Resource: "*",
    },
  ],
};

/**
 * Returns formatted JSON policy document for the pi-cloud-agents Operator.
 */
export function generateOperatorPolicyJson(): string {
  return JSON.stringify(OPERATOR_POLICY_DOCUMENT, null, 2);
}

/**
 * Generates standalone CloudFormation YAML template for account admins.
 */
export function generateOperatorPolicyCfnYaml(
  policyName = "pi-cloud-agents-operator-policy",
): string {
  return `AWSTemplateFormatVersion: "2012-10-17"
Description: "Least-privilege IAM managed policy for pi-cloud-agents operators"

Parameters:
  PolicyName:
    Type: String
    Default: "${policyName}"
    Description: "Name of the IAM Managed Policy"

Resources:
  OperatorManagedPolicy:
    Type: AWS::IAM::ManagedPolicy
    Properties:
      ManagedPolicyName: !Ref PolicyName
      Description: "Least-privilege permissions to deploy and manage pi-cloud-agents"
      PolicyDocument:
${JSON.stringify(OPERATOR_POLICY_DOCUMENT, null, 8)
  .split("\n")
  .map((line) => `        ${line}`)
  .join("\n")}

Outputs:
  PolicyArn:
    Value: !Ref OperatorManagedPolicy
    Description: "ARN of the created IAM Managed Policy"
`;
}

/**
 * Attempts direct creation of IAM Managed Policy if credentials permit.
 */
export async function createOperatorPolicyDirectly(
  iamClient: IAMClient,
  policyName = "pi-cloud-agents-operator-policy",
): Promise<{ policyArn?: string; created: boolean }> {
  try {
    const res = await iamClient.send(
      new CreatePolicyCommand({
        PolicyName: policyName,
        Description: "Least-privilege permissions to deploy and manage pi-cloud-agents",
        PolicyDocument: generateOperatorPolicyJson(),
      }),
    );
    return {
      policyArn: res.Policy?.Arn,
      created: true,
    };
  } catch (err: unknown) {
    throw new Error(`Failed to create IAM policy '${policyName}': ${(err as Error).message}`);
  }
}
