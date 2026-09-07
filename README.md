# pi-cloud-agents

Autonomous cloud agents for [pi](https://pi.dev) running inside Firecracker-isolated AWS Lambda MicroVMs in your own AWS account, with rich local TUI mirroring, zero-idle costs, and verified one-command setup.

```bash
# 1. Install extension into pi
pi install npm:pi-cloud-agents

# 2. Automated 1-command setup and verification
npx pi-cloud-agents setup --verify

# 3. Launch and manage cloud agents
pi
/cloud new "Add retry logic to the S3 uploader and open a PR"
/cloud attach <runId>
```

---

## Key Features

- **Isolated AWS Lambda MicroVMs**: Every agent runs in a dedicated Firecracker MicroVM container (ARM64 AL2023) in your own AWS account.
- **Rich Local TUI Mirroring**: Live streamed assistant responses, collapsible thinking blocks, syntax-highlighted diffs, tool execution logs, and live telemetry footers.
- **Laptop-Close Resilience**: Close your laptop or detach with `/cloud detach`; the cloud agent continues autonomously. Reopening `pi -c` reattaches seamlessly with zero duplicate entries.
- **Any pi Model & Provider**: Automatically reuses your local pi credentials (`auth.json`, `models.json`, API keys, Anthropic/OpenAI/Copilot OAuth, Amazon Bedrock).
- **$0.00 Idle Cost**: MicroVMs suspend automatically when idle. You pay only for active CPU seconds.
- **Git Checkpoints & Pull Requests**: Auto-commits changes to `pi-cloud/<runId>` work branches and creates pull requests with `/cloud pr`.

---

## Quickstart

### 1. Prerequisites
- Node.js >= 22.19
- AWS account with credentials configured in `~/.aws/credentials` or `AWS_PROFILE` (default region: `us-east-1`).
- Pinned `pi` CLI installed.

### 2. Setup
Run the automated setup wizard:
```bash
npx pi-cloud-agents setup --verify
```
*Or from inside the pi TUI:*
```
/cloud setup
```

The wizard deploys:
1. **Core CloudFormation Stack**: Secure S3 artifact & session storage bucket, minimal IAM execution roles.
2. **Image CloudFormation Stack**: Lambda MicroVM runner image, 1-minute Controller Lambda daemon for keepalive and auto-suspension.
3. **Pi Config Bundle**: Synced model credentials stored securely in AWS Secrets Manager.
4. **Verification Engine**: Executes static permission probes and a zero-token smoke run.

---

## Commands Reference

### TUI Commands (Inside pi)

| Command | Description |
|---|---|
| `/cloud` | Opens the Cloud Hub overview and quick actions |
| `/cloud new [prompt]` | Launches a new autonomous cloud agent |
| `/cloud list` | Lists all active and recent cloud runs with status badges and costs |
| `/cloud status [runId]` | Displays comprehensive metrics timeline, tool stats, and VM resources |
| `/cloud attach [runId]` | Attaches live mirror session to an active cloud agent |
| `/cloud detach` | Detaches from mirror session without interrupting the cloud agent |
| `/cloud abort [runId]` | Aborts current turn on the remote agent (`ctrl+alt+c`) |
| `/cloud continue <runId>`| Continues a completed run across the 8-hour MicroVM limit |
| `/cloud logs <runId> [--follow]` | Streams real-time CloudWatch logs for a run |
| `/cloud pr <runId> [title]` | Finalizes work branch and opens a GitHub Pull Request |
| `/cloud shell <runId>` | Opens an interactive PTY shell inside the running MicroVM |
| `/cloud config [key] [val]` | Views and updates local settings and budget limits |
| `/cloud sync` | Refreshes synced provider API keys and model configurations |
| `/cloud dashboard` | Live fleet observability view with event-rate sparklines |
| `/cloud verify` | Runs full system health and diagnostic smoke tests |
| `/cloud doctor` | Checks local configuration, AWS credentials, and stack drift |
| `/cloud diag <runId>` | Exports sanitized diagnostics bundle for troubleshooting |
| `/cloud update` | Rebuilds and updates MicroVM runner image stack |
| `/cloud destroy` | Completely tears down all cloud infrastructure and deletes secrets |
| `/cloud iam-policy` | Displays least-privilege IAM policy for AWS account admins |

### Standalone CLI Commands

```bash
npx pi-cloud-agents setup [--verify] [--dry-run] [--profile <p>] [--region <r>]
npx pi-cloud-agents verify [--with-model] [--json]
npx pi-cloud-agents doctor [--json]
npx pi-cloud-agents config [key] [val]
npx pi-cloud-agents sync
npx pi-cloud-agents update
npx pi-cloud-agents destroy [--force]
npx pi-cloud-agents iam-policy [--yaml]
```

---

## Model Delegation Tool (`cloud_agent`)

The local LLM can autonomously delegate tasks to cloud agents using the built-in `cloud_agent` tool:
```json
{
  "action": "launch",
  "prompt": "Implement user authentication with JWT and write unit tests"
}
```
Actions supported: `launch`, `status`, `result`, `steer`, `stop`.

---

## Pricing and Cost Model

- **Idle MicroVMs**: $0.00 / month (suspended VMs incur only S3 snapshot storage at ~$0.08/GB-month).
- **Running MicroVMs**:
  - vCPU: $0.0000276944 / second
  - Memory: $0.0000036667 / GB-second
  - *Example*: A 2 vCPU / 4 GB MicroVM running for 15 minutes costs ~$0.03 total.
- **Budget Guards**: Built-in maximum duration bounds (<= 8h), concurrency limits (`defaults.maxConcurrent`), and month-to-date budget warnings.

---

## Security Model

- **Firecracker Hypervisor Isolation**: Hardware-level virtualization isolation for every run.
- **Least-Privilege Execution Role**: MicroVMs possess zero `lambda:*` permissions and access only scoped stack prefixes in S3 and Secrets Manager.
- **Secret Redaction**: In-VM extensions and runner loggers recursively redact all registered secrets with `[REDACTED]`.
- **Proxy Authentication**: Port-scoped JWE proxy tokens with 30-minute expiration.

---

## License

MIT License.
