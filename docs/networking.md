# Networking and Private Access Architecture (T5.5)

This document describes network connectivity, VPC egress connectors, and corporate proxy configurations for **pi-cloud-agents** in AWS Lambda MicroVMs.

---

## 1. Managed Network Connectors

AWS Lambda MicroVMs provide managed network connectors for common ingress and egress patterns:

| Connector Name | ARN Pattern | Use Case |
|---|---|---|
| `ALL_INGRESS` | `arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:ALL_INGRESS` | Allows HTTP, HTTPS, WebSocket, gRPC, and SSE traffic to the MicroVM endpoint |
| `HTTP_INGRESS` | `arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:HTTP_INGRESS` | Restricts ingress to HTTP/HTTPS/WebSocket port 8080 |
| `SHELL_INGRESS` | `arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:SHELL_INGRESS` | Enables WebSocket SSH/PTY shell access on port 8022 (`/cloud shell`) |
| `NO_INGRESS` | `arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:NO_INGRESS` | Fully blocks all incoming proxy connections |
| `INTERNET_EGRESS` | `arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:INTERNET_EGRESS` | Default outbound access to public internet (GitHub, LLM APIs, npm) |

---

## 2. Customer VPC Egress Connectors (Private Subnets)

For enterprise environments where agents must access internal resources:
- Internal GitHub Enterprise / GitLab servers
- Private package registries (JFrog Artifactory, Sonatype Nexus, AWS CodeArtifact)
- Private databases or staging microservices

### Creating a Customer VPC Egress Connector
Using AWS CLI or CloudFormation:
```bash
aws lambda-core create-network-connector \
  --name "pi-cloud-corp-vpc" \
  --type "VPC_EGRESS" \
  --vpc-config SubnetIds=subnet-12345,subnet-67890,SecurityGroupIds=sg-abcdef
```

### Configuring pi-cloud-agents to use the Custom Connector
Update `~/.pi/agent/pi-cloud-agents.json` or run:
```bash
/cloud config egressConnectorArn arn:aws:lambda:us-east-1:123456789012:network-connector:pi-cloud-corp-vpc
```

When configured, `RunMicrovm` attaches the custom VPC connector instead of the default `INTERNET_EGRESS`.

---

## 3. Forward Proxy & `HTTPS_PROXY`

If your VPC routes outbound internet through an authenticated corporate forward proxy:
1. Configure proxy environment variables in `.pi/cloud-agents.json`:
   ```json
   {
     "env": {
       "HTTPS_PROXY": "http://proxy.internal.corp:8080",
       "HTTP_PROXY": "http://proxy.internal.corp:8080",
       "NO_PROXY": "169.254.169.254,169.254.169.253,localhost,127.0.0.1"
     }
   }
   ```
2. Note that `169.254.169.254` (IMDSv2) and `169.254.169.253` (Platform DNS Stub) must always be in `NO_PROXY`.

---

## 4. UDP and DNS Restrictions

- Inbound and outbound UDP is blocked by default in AWS Lambda MicroVMs.
- All guest DNS resolution is routed through the AWS Platform DNS Stub at `169.254.169.253`.
