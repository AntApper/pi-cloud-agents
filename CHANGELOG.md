# Changelog

All notable changes to **pi-cloud-agents** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] - 2026-09-06

### Added
- **Phase 0: Foundations & De-risking Spikes**:
  - AWS account readiness probe and kill-switch cleanup engine (`T0.2`).
  - Hello MicroVM end-to-end SDK deployment spike (`T0.3`).
  - Guest capabilities, keepalive, and controller-driven idle handling spike (`T0.4`).
  - Pi headless on ARM64 AL2023 with zero-token mock LLM scripted provider (`T0.5`).
  - Pi credential portability and OAuth token collision analysis (`T0.6`).
- **Phase 1: Contracts & Shared Schemas**:
  - `LaunchPayload`, `RunManifest`, `RunnerStatus`, and SSE event schemas with JSON schema generator (`T1.1`).
  - Local and per-repo configuration loaders with mode 0600 storage (`T1.2`).
  - Runner API protocol and contract specification (`T1.3`).
  - Pure TypeScript pi config bundle builder with zero secret leakage in TAR archives (`T1.4`).
- **Phase 2: In-VM Runner**:
  - MicroVM lifecycle hook server on port 9000 (`T2.1`).
  - Launch payload handler, Secrets Manager provider, and recursive redaction logger (`T2.2`).
  - Workspace preparation with `GIT_ASKPASS` credential security (`T2.3`).
  - Pi process manager with LF-only JSONL RPC parsing and crash recovery (`T2.4`).
  - Runner HTTP REST API and SSE streaming server (`T2.5a`).
  - WebSocket RPC bidirectional passthrough and attached client routing (`T2.5b`).
  - Run state machine and debounced S3 manifest persistence (`T2.6`).
  - Lifecycle policy with automated git checkpoint commits on `agent_settled` (`T2.7`).
  - Runner metrics collector and observability timeline (`T2.10`).
  - Local dev harness and zero-cost `npm run e2e:local` test suite (`T2.8`).
  - Deterministic image zip packager and final ARM64 Dockerfile (`T2.9`).
- **Phase 3: Infrastructure**:
  - CloudFormation core stack (`infra/core.yaml`) with least-privilege IAM policies (`T3.1a`).
  - CloudFormation image stack (`infra/image.yaml`) with MicroVM image resource and Controller Lambda (`T3.1b`).
  - CloudFormation stack deployer with change set execution and error diagnostics (`T3.2`).
  - Lambda MicroVM image manager with build polling and version pruning (`T3.3`).
  - AWS Secrets Manager credentials store and run secret janitor (`T3.4`).
  - Controller Lambda scheduled daemon for 1-minute keepalive and idle suspension (`T3.5`).
- **Phase 4: Local Extension & CLI**:
  - Extension skeleton, `/cloud` command router, and `/cloud doctor` diagnostics (`T4.1a`).
  - Typography UI kit with zero-emoji lint compliance (`T4.1b`).
  - AWS SDK client factory with actionable error mapping (`T4.2`).
  - `/cloud setup` wizard step machine and prompter abstraction (`T4.3a`).
  - Setup execution engine with resumable step ledger (`T4.3b`).
  - Standalone `pi-cloud-agents` CLI tool (`T4.3c`).
  - Full system verification engine and `/cloud verify` (`T4.3d`).
  - `/cloud new` launch flow and orchestrator (`T4.4`).
  - RunClient with proxy token management, SSE streams, and WebSocket RPC (`T4.5`).
  - `/cloud list` and `/cloud status` detail cards (`T4.6`).
  - `/cloud attach` mirror session core and entry synchronization (`T4.7a`).
  - Mirror input forwarding, steer, abort, and remote UI handling (`T4.7b`).
  - Rich message renderers and live status footer (`T4.7c`).
  - Mirror durability, auto-reattach, and laptop-close recovery (`T4.7d`).
  - Control commands: `stop`, `suspend`, `resume`, `logs`, `pr`, `shell` (`T4.8`).
  - Local LLM delegation tool `cloud_agent` (`T4.9`).
  - `/cloud update` and `/cloud destroy` stack lifecycle management (`T4.10`).
  - `/cloud config` settings screen and editor (`T4.11`).
  - `/cloud open` native read-only session viewer (`T4.12`).
  - `/cloud sync` pi credentials refresher (`T4.13`).
  - `/cloud dashboard` live fleet view with sparklines (`T4.14`).
  - Cloud Hub, first-run experience, and IAM operator policy helper (`T4.15`).
- **Phase 5: Hardening & Continuation**:
  - In-VM secret redaction extension (`T5.1`).
  - Run-scoped GitHub credentials via GitHub App authentication (`T5.2`).
  - Multi-turn run continuation past the 8-hour limit via `/cloud continue` (`T5.3`).
  - Cost and budget guard with month-to-date thresholds (`T5.4`).
  - Networking architecture and VPC egress connector guide (`T5.5`).
  - Observability and diagnostics bundle exporter (`T5.6`).
  - STRIDE threat model and protocol fuzz testing (`T5.7`).
  - User documentation and release packaging (`T5.8`).
