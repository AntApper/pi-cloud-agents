# Threat Model and Security Architecture (T5.7)

This document presents the STRIDE threat model and security boundary controls for **pi-cloud-agents**.

---

## 1. Trust Boundaries and System Model

```
 ┌─────────────────────────────────────────────────────────────┐
 │                      User Local Machine                     │
 │  - Local pi session / Mirror UI                             │
 │  - ~/.pi/agent/auth.json (Secrets stored locally)           │
 └──────────────────────────────┬──────────────────────────────┘
                                │ HTTPS / WSS Proxy Auth Token (30m)
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │               AWS Cloud Control Plane (User AWS Account)    │
 │  - AWS Secrets Manager (Credentials encrypted with KMS)     │
 │  - AWS S3 (Artifacts and transcripts, Block Public Access)  │
 │  - AWS Lambda Controller (1-minute keepalive/idle enforcer) │
 └──────────────────────────────┬──────────────────────────────┘
                                │ Isolated Firecracker MicroVM Launch
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │           Lambda MicroVM Isolated Guest Container           │
 │  - Firecracker hardware virtualization / cgroup isolation   │
 │  - Minimal Execution Role via IMDSv2 (read-only/scoped)     │
 │  - Local askpass Git credentials (never written to disk)    │
 │  - In-VM pi process and tool execution                      │
 └─────────────────────────────────────────────────────────────┘
```

---

## 2. STRIDE Threat Analysis & Mitigations

### 1. Spoofing
- **Threat**: Unauthorized caller sending prompt commands to MicroVM endpoint.
- **Mitigation**: Every inbound connection requires an `X-aws-proxy-auth` JWE token minted via `CreateMicrovmAuthToken` with restricted port scope (port 8080 only) and short TTL (30 min).

### 2. Tampering
- **Threat**: Altering git configuration or credentials during repo workspace setup.
- **Mitigation**: `GIT_ASKPASS` helper dynamically feeds tokens without modifying `.git/config` or remote origin URLs.

### 3. Repudiation
- **Threat**: Cloud agent making unlogged changes or operations.
- **Mitigation**: All tool calls, turns, commits, and timestamps are recorded in the `session.jsonl` transcript and mirrored to S3.

### 4. Information Disclosure
- **Threat**: Leaking LLM provider API keys or GitHub tokens into logs or terminal mirrors.
- **Mitigation**:
  - `runner/logger.ts` redacts registered secrets recursively with `[REDACTED]`.
  - `runner/pi-extensions/redact.ts` sanitizes tool outputs and assistant messages in-VM.
  - `maskObject` masks 12-digit AWS account IDs as `<ACCOUNT_ID>`.

### 5. Denial of Service / Cost Runaway
- **Threat**: Orphaned or runaway agent loops causing unlimited AWS compute bills.
- **Mitigation**:
  - Hard 8-hour lifetime on all MicroVMs (`maximumDurationInSeconds <= 28800`).
  - Outside Controller Lambda polls every minute and suspends idle VMs.
  - Concurrency caps (`maxConcurrent`) enforced before launch.

### 6. Elevation of Privilege
- **Threat**: Untrusted code in guest accessing AWS control plane via IMDSv2.
- **Mitigation**:
  - MicroVM Execution Role has **zero `lambda:*` permissions**.
  - S3 and Secrets Manager permissions are strictly restricted to the user's stack prefix (`pi-cloud-agents/<stack>/*`).
