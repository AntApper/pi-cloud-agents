# IAM Security and Permission Boundaries

This document defines the IAM architecture, permission boundaries, and security model for `pi-cloud-agents`.

---

## 1. Overview of Roles and Policies

The system uses four distinct IAM entities, each bound by strict least-privilege principles:

| Principal / Entity | Assumed By | Purpose | Key Permissions |
|---|---|---|---|
| **Operator** | Local developer or CI/CD identity | Stack deployment, MicroVM launch, lifecycle control, secret sync | CloudFormation, S3, Secrets Manager (stack prefix), `lambda:*Microvm*`, `lambda:PassNetworkConnector` |
| **BuildRole** | `lambda.amazonaws.com` (Image builder) | Assembles MicroVM rootfs and snapshot from S3 runner bundle | Read `s3://<bucket>/runner/*`, write build CloudWatch logs |
| **ExecutionRole** | `lambda.amazonaws.com` (Guest runtime) | Ambient credentials available to MicroVM guest processes | Read/write `s3://<bucket>/runs/*`, read `s3://<bucket>/config/*`, read Secrets Manager `pi-cloud-agents/<stack>/*`, write CloudWatch logs, optional Bedrock invoke. **NO `lambda:*`** |
| **ControllerRole** | `lambda.amazonaws.com` (Controller Lambda) | Scheduled keepalive, external idle suspend/terminate, janitor | `lambda:{ListMicrovms,GetMicrovm,SuspendMicrovm,TerminateMicrovm,CreateMicrovmAuthToken}`, S3 manifest read/write, force-delete run secrets |

---

## 2. Operator Policy (`OperatorPolicy`)

The `OperatorPolicy` managed policy is created by the `pi-cloud-agents-core` CloudFormation stack. It can be attached to any IAM User, Role, or SSO Permission Set that needs to operate pi-cloud-agents.

### Scoped Permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudFormationStackOps",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:GetTemplate",
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:ListChangeSets"
      ],
      "Resource": [
        "arn:aws:cloudformation:<region>:<account>:stack/pi-cloud-agents*/*",
        "arn:aws:cloudformation:<region>:<account>:changeSet/*/*"
      ]
    },
    {
      "Sid": "S3ArtifactBucketOps",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:GetBucketLocation",
        "s3:GetBucketPolicy",
        "s3:PutBucketPolicy",
        "s3:GetBucketVersioning",
        "s3:PutBucketVersioning",
        "s3:GetBucketPublicAccessBlock",
        "s3:PutBucketPublicAccessBlock",
        "s3:GetEncryptionConfiguration",
        "s3:PutEncryptionConfiguration",
        "s3:GetLifecycleConfiguration",
        "s3:PutLifecycleConfiguration",
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion"
      ],
      "Resource": [
        "arn:aws:s3:::<bucket-name>",
        "arn:aws:s3:::<bucket-name>/*"
      ]
    },
    {
      "Sid": "SecretsManagerOps",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:CreateSecret",
        "secretsmanager:UpdateSecret",
        "secretsmanager:PutSecretValue",
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret",
        "secretsmanager:DeleteSecret",
        "secretsmanager:TagResource",
        "secretsmanager:UntagResource"
      ],
      "Resource": "arn:aws:secretsmanager:<region>:<account>:secret:pi-cloud-agents/<stack>/*"
    },
    {
      "Sid": "MicrovmImageOps",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateMicrovmImage",
        "lambda:UpdateMicrovmImage",
        "lambda:GetMicrovmImage",
        "lambda:GetMicrovmImageBuild",
        "lambda:ListMicrovmImages",
        "lambda:ListMicrovmImageVersions",
        "lambda:DeleteMicrovmImage",
        "lambda:DeleteMicrovmImageVersion",
        "lambda:TagResource",
        "lambda:UntagResource"
      ],
      "Resource": [
        "arn:aws:lambda:<region>:<account>:microvm-image:<image-name>",
        "arn:aws:lambda:<region>:<account>:microvm-image:<image-name>:*"
      ]
    },
    {
      "Sid": "MicrovmRuntimeOps",
      "Effect": "Allow",
      "Action": [
        "lambda:RunMicrovm",
        "lambda:GetMicrovm",
        "lambda:ListMicrovms",
        "lambda:SuspendMicrovm",
        "lambda:ResumeMicrovm",
        "lambda:TerminateMicrovm",
        "lambda:CreateMicrovmAuthToken",
        "lambda:CreateMicrovmShellAuthToken"
      ],
      "Resource": [
        "arn:aws:lambda:<region>:<account>:microvm:*",
        "arn:aws:lambda:<region>:<account>:microvm-image:<image-name>",
        "arn:aws:lambda:<region>:<account>:microvm-image:<image-name>:*"
      ]
    },
    {
      "Sid": "PassNetworkConnector",
      "Effect": "Allow",
      "Action": "lambda:PassNetworkConnector",
      "Resource": [
        "arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:*",
        "arn:aws:lambda:<region>:<account>:network-connector:*"
      ]
    },
    {
      "Sid": "PassRoleToMicrovm",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "<build-role-arn>",
        "<execution-role-arn>"
      ],
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "lambda.amazonaws.com"
        }
      }
    },
    {
      "Sid": "CloudWatchLogsOps",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
        "logs:FilterLogEvents",
        "logs:GetLogEvents",
        "logs:PutRetentionPolicy"
      ],
      "Resource": [
        "arn:aws:logs:<region>:<account>:log-group:/aws/lambda/microvms/*",
        "arn:aws:logs:<region>:<account>:log-group:/aws/lambda-microvms/*",
        "arn:aws:logs:<region>:<account>:log-group:/pi-cloud-agents/*"
      ]
    },
    {
      "Sid": "DiscoveryAndReadinessOps",
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity",
        "lambda:ListManagedMicrovmImages",
        "lambda:ListManagedMicrovmImageVersions",
        "lambda:ListMicrovmImages",
        "lambda:ListMicrovms",
        "secretsmanager:ListSecrets",
        "servicequotas:GetServiceQuota",
        "servicequotas:ListServiceQuotas"
      ],
      "Resource": "*"
    }
  ]
}
```

---

## 3. Build Role (`BuildRole`)

Used by the AWS Lambda MicroVM image build infrastructure when compiling the Dockerfile and taking the memory snapshot.

### Trust Policy
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": [
        "sts:AssumeRole",
        "sts:TagSession"
      ],
      "Condition": {
        "StringEquals": {
          "aws:SourceAccount": "<account-id>"
        }
      }
    }
  ]
}
```

### Permissions
- `s3:GetObject` on `s3://<bucket>/runner/*`
- `logs:CreateLogStream`, `logs:PutLogEvents`, `logs:DescribeLogStreams` on `/aws/lambda/microvms/*` and `/aws/lambda-microvms/*`
- Optional `kms:Decrypt` on customer-managed KMS key

---

## 4. Execution Role (`ExecutionRole`)

Assumed during MicroVM execution. Because guest processes (and any code generated by LLMs) have ambient access to execution role credentials via IMDSv2 (`169.254.169.254/latest/meta-data/iam/security-credentials/execution_role`), this role is intentionally minimal.

### Trust Policy
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": [
        "sts:AssumeRole",
        "sts:TagSession"
      ],
      "Condition": {
        "StringEquals": {
          "aws:SourceAccount": "<account-id>"
        }
      }
    }
  ]
}
```

### Permissions
- S3 read/write on `runs/*` and `index/*`
- S3 read-only on `config/*`
- Secrets Manager read on `pi-cloud-agents/<stack>/*`
- CloudWatch logs write to `/aws/lambda/microvms/*` and `/aws/lambda-microvms/*`
- Optional Bedrock invoke (`bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`)
- Optional KMS decrypt if customer-managed KMS key is used

### Explicit Non-Permissions
- **NO `lambda:*` permissions**. Guest code cannot suspend, resume, terminate, or inspect other MicroVMs.
- **NO IAM permissions**. Guest code cannot escalate privileges or create credentials.
- **NO cross-stack or un-prefixed S3/Secrets Manager access**.

---

## 5. Controller Role (`ControllerRole`)

Used by the 1-minute scheduled controller Lambda function deployed in `infra/image.yaml`.

### Trust Policy
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "aws:SourceAccount": "<account-id>"
        }
      }
    }
  ]
}
```

### Permissions
- `lambda:ListMicrovms`, `lambda:GetMicrovm`, `lambda:SuspendMicrovm`, `lambda:TerminateMicrovm`, `lambda:CreateMicrovmAuthToken` on the image
- S3 read/write on `runs/*`, `index/*`, and `controller/*`
- `secretsmanager:ListSecrets` on `Resource: "*"` (`JanitorSecretDiscovery`). ListSecrets does not
  support resource-level permissions, so `*` is the narrowest possible grant; the call returns
  names and metadata only, never values, and the controller filters on
  `pi-cloud-agents/<stack>/runs/`. This is the only wildcard resource in the role and the
  `infra-policies` unit test fails if any other action is granted on `*`.
- `secretsmanager:DeleteSecret` on `pi-cloud-agents/<stack>/runs/*` (for janitor cleanup of run-scoped credentials)
- CloudWatch logs write to `/pi-cloud-agents/<stack>/controller`
- When a customer-managed KMS key is configured (`kmsKeyArn` in the local config, passed as the
  `KmsKeyArn` parameter to both stacks): `kms:Decrypt`, `kms:DescribeKey`, `kms:GenerateDataKey*`
  on that key only, because the artifact bucket is then SSE-KMS encrypted and the controller both
  reads manifests and writes its health state there. Without a key the statement is omitted.

---

## 6. Security Guarantees & Confused Deputy Prevention

1. **Confused-Deputy Protection**: All role trust policies include `aws:SourceAccount: <account-id>` conditions.
2. **Network Connector Authorization**: `lambda:PassNetworkConnector` is explicitly restricted to AWS-managed network connector ARNs and account-owned VPC connectors.
3. **No Self-Suspend**: The guest runner never interacts with the Lambda control plane; all suspend/resume/terminate decisions are externally enforced by the Controller Lambda or local operator client.
