# Task status tracker

Statuses: `todo` · `ready` (deps done) · `in-progress` (agent, started) · `blocked` (reason) · `done` (evidence link) · gates: `pending` / `passed`.
Agents: update the row when you start and finish a task; add the evidence link. Owner: record
decisions in the log at the bottom. **Implementation has not started (owner decision Q11).**

## Phase 0 — Foundations and spikes

| Task | Title | Size | Depends on | Status | Evidence |
|---|---|---|---|---|---|
| T0.1 | Repository scaffold and toolchain | S/M | — | done | [docs/evidence/T0.1.md](docs/evidence/T0.1.md) |
| T0.2 | Spike: AWS account readiness + kill-switch [AWS] | S | T0.1 | done | [docs/evidence/T0.2.md](docs/evidence/T0.2.md) |
| T0.3 | Spike: hello MicroVM end to end [AWS] | M | T0.2 | done | [docs/evidence/T0.3.md](docs/evidence/T0.3.md) |
| T0.4 | Spike: guest capabilities + keepalive [AWS] | M | T0.3 | done | [docs/evidence/T0.4.md](docs/evidence/T0.4.md) |
| T0.5 | Spike: pi headless on ARM64 + mock LLM [AWS] | M | T0.3 | done | [docs/evidence/T0.5.md](docs/evidence/T0.5.md) |
| T0.6 | Spike: pi credential portability (API keys, OAuth) | M | T0.1 | done | [docs/evidence/T0.6.md](docs/evidence/T0.6.md) |
| G0 | Gate: spikes complete, decisions confirmed | S | T0.2–T0.6 | passed | Phase 0 spikes complete, assumptions A1–A10 verified |
|
## Phase 1 — Contracts

| Task | Title | Size | Depends on | Status | Evidence |
|---|---|---|---|---|---|
| T1.1 | Protocol and manifest schemas | M | G0 | done | [docs/evidence/T1.1.md](docs/evidence/T1.1.md) |
| T1.2 | Local and per-repo config schemas + loader | S/M | T1.1 | done | [docs/evidence/T1.2.md](docs/evidence/T1.2.md) |
| T1.3 | Runner API contract document | S | T1.1 | done | [docs/evidence/T1.3.md](docs/evidence/T1.3.md) |
| T1.4 | pi config bundle builder (`core/pi-config`) | M | T1.1, T0.6 | done | [docs/evidence/T1.4.md](docs/evidence/T1.4.md) |

## Phase 2 — Runner

| Task | Title | Size | Depends on | Status | Evidence |
|---|---|---|---|---|---|
| T2.1 | Lifecycle hook server | M | T1.1 | done | [docs/evidence/T2.1.md](docs/evidence/T2.1.md) |
| T2.2 | Launch payload, secrets, pi config assembly | M | T2.1, T1.4 | done | [docs/evidence/T2.2.md](docs/evidence/T2.2.md) |
| T2.3 | Workspace preparation (git + install) | M | T2.2 | done | [docs/evidence/T2.3.md](docs/evidence/T2.3.md) |
| T2.4 | pi process manager (RPC bridge) | M | T2.2 | done | [docs/evidence/T2.4.md](docs/evidence/T2.4.md) |
| T2.5a | Runner HTTP API (REST + SSE) | M | T2.4, T1.3 | done | [docs/evidence/T2.5a.md](docs/evidence/T2.5a.md) |
| T2.5b | Runner WebSocket RPC passthrough | M | T2.5a | done | [docs/evidence/T2.5b.md](docs/evidence/T2.5b.md) |
| T2.6 | Run state machine and persistence | M | T2.2 | done | [docs/evidence/T2.6.md](docs/evidence/T2.6.md) |
| T2.7 | Lifecycle policy (idle reporting, finalize, resume recovery) | M | T2.5a, T2.6 | done | [docs/evidence/T2.7.md](docs/evidence/T2.7.md) |
| T2.10 | Runner metrics and lifecycle timeline | M | T2.5a, T2.6 | done | [docs/evidence/T2.10.md](docs/evidence/T2.10.md) |
| T2.8 | Local harness, mock LLM, e2e:local | M | T2.3, T2.5b, T2.7, T2.10 | done | [docs/evidence/T2.8.md](docs/evidence/T2.8.md) |
| G2 | Gate: local end-to-end run | S | T2.8 | passed | Phase 2 complete, local e2e run and zero secrets verified |
| T2.9 | Runner bundle, Dockerfile, image zip | M | G2, T0.5 | done | [docs/evidence/T2.9.md](docs/evidence/T2.9.md) |

## Phase 3 — Infrastructure

| Task | Title | Size | Depends on | Status | Evidence |
|---|---|---|---|---|---|
| T3.1a | CloudFormation core stack | M | T1.1 | done | [docs/evidence/T3.1a.md](docs/evidence/T3.1a.md) |
| T3.1b | CloudFormation image stack | M | T3.1a | done | [docs/evidence/T3.1b.md](docs/evidence/T3.1b.md) |
| T3.2 | Stack deployer module | M | T3.1b | done | [docs/evidence/T3.2.md](docs/evidence/T3.2.md) |
| T3.3 | Image manager | M | T3.2, T2.9 | done | [docs/evidence/T3.3.md](docs/evidence/T3.3.md) |
| T3.4 | Secrets store (AWS Secrets Manager) | S/M | T1.2 | done | [docs/evidence/T3.4.md](docs/evidence/T3.4.md) |
| T3.5 | Controller Lambda (keepalive, idle policy, janitor) | M | T2.6, T2.7, T3.1b | done | [docs/evidence/T3.5.md](docs/evidence/T3.5.md) |
| G3 | Gate: live infra smoke [AWS] | M | T3.2–T3.5, T2.9 | passed | [docs/evidence/G3.md](docs/evidence/G3.md) |

## Phase 4 — Local extension and CLI

| Task | Title | Size | Depends on | Status | Evidence |
|---|---|---|---|---|---|
| T4.1a | Extension skeleton, router, doctor | M | G2 | done | [docs/evidence/T4.1a.md](docs/evidence/T4.1a.md) |
| T4.1b | UI kit and style compliance (no-emoji lint) | M | T4.1a | done | [docs/evidence/T4.1b.md](docs/evidence/T4.1b.md) |
| T4.2 | AWS client factory and error mapping | S/M | T1.2 | done | [docs/evidence/T4.2.md](docs/evidence/T4.2.md) |
| T4.3a | Setup wizard: quick setup default + custom | M | T4.1a, T4.1b, T4.2, T3.4 | done | [docs/evidence/T4.3a.md](docs/evidence/T4.3a.md) |
| T4.3b | Setup execution (deploy, image, bundle, secrets) | M | T4.3a, T3.2, T3.3 | done | [docs/evidence/T4.3b.md](docs/evidence/T4.3b.md) |
| T4.3c | Standalone CLI `npx pi-cloud-agents` | M | T4.3b | done | [docs/evidence/T4.3c.md](docs/evidence/T4.3c.md) |
| T4.3d | Verification engine + `/cloud verify` | M | T4.3b, T4.5, T2.8 | done | [docs/evidence/T4.3d.md](docs/evidence/T4.3d.md) |
| T4.4 | `/cloud new` launch flow | M | T4.3b, T1.1 | done | [docs/evidence/T4.4.md](docs/evidence/T4.4.md) |
| T4.5 | Run client (tokens, HTTP, SSE, WS) | M | T2.5b, T4.2 | done | [docs/evidence/T4.5.md](docs/evidence/T4.5.md) |
| T4.6 | `/cloud list` and `/cloud status` detail card | M | T4.5, T2.6, T2.10, T4.1b | done | [docs/evidence/T4.6.md](docs/evidence/T4.6.md) |
| T4.7a | Attach: mirror session core | M | T4.5, T4.6 | done | [docs/evidence/T4.7a.md](docs/evidence/T4.7a.md) |
| T4.7b | Attach: input forwarding and controls | M | T4.7a | done | [docs/evidence/T4.7b.md](docs/evidence/T4.7b.md) |
| T4.7c | Attach: rich renderers and remote footer | M | T4.7a | todo | |
| T4.7d | Attach: durability, auto-reattach, laptop-close | M | T4.7a, T4.5 | todo | |
| T4.8 | stop / suspend / resume / logs / pr / shell | M | T4.5 | done | [docs/evidence/T4.8.md](docs/evidence/T4.8.md) |
| T4.9 | `cloud_agent` tool | M | T4.4, T4.6, T4.8 | ready | |
| T4.10 | `/cloud update` and `/cloud destroy` | M | T4.3b, T3.3 | done | [docs/evidence/T4.10.md](docs/evidence/T4.10.md) |
| T4.11 | `/cloud config` settings screen | M | T4.1a, T4.1b, T1.2 | done | [docs/evidence/T4.11.md](docs/evidence/T4.11.md) |
| T4.12 | `/cloud open` native read-only viewer | S/M | T4.5 | ready | |
| T4.13 | `/cloud sync` pi config bundle refresh | S/M | T1.4, T3.4, T4.2 | done | [docs/evidence/T4.13.md](docs/evidence/T4.13.md) |
| T4.14 | `/cloud dashboard` live fleet view | M | T4.6, T4.5, T2.10, T4.1b | ready | |
| T4.15 | Hub, quick-setup polish, first-run, IAM helper | M | T4.3a, T4.3b, T4.3d, T4.1b | todo | |
| G4 | Gate: real end-to-end cloud agent + UX review [AWS] | M | T4.1a–T4.15, G3 | pending | |

## Phase 5 — Hardening and release

| Task | Title | Size | Depends on | Status | Evidence |
|---|---|---|---|---|---|
| T5.1 | In-VM secret redaction | M | G4 | todo | |
| T5.2 | Run-scoped GitHub credentials (OAuth/App) | M | G4 | todo | |
| T5.3 | Continuation past 8 h | M/L | G4 | todo | |
| T5.4 | Cost and budget guard | M | T4.6 | todo | |
| T5.5 | Networking options + docs | S/M | G4 | todo | |
| T5.6 | Observability and diagnostics | M | T4.8 | todo | |
| T5.7 | Security review gate | M | T5.1, T5.2, T5.4, T5.6 | todo | |
| T5.8 | Docs and release | M | T5.7, T4.10 | todo | |
| T5.9 | OAuth token broker (conditional on T0.6) | M/L | T0.6, T4.13 | todo (conditional) | |
| G5 | Gate: security review + release | S | T5.7, T5.8 | pending | |

## Decisions log (owner)

| Date | Question / ADR | Decision |
|---|---|---|
| 2026-09-06 | Q1 runtime mode | Agent loop in VM; local pi mirrors it; reopening pi shows the active cloud session |
| 2026-09-06 | Q2 providers | Support everything pi supports by reusing pi's credential/model system |
| 2026-09-06 | Q3 git hosting | GitHub; PAT for MVP; OAuth later |
| 2026-09-06 | Q4 tenancy | Team share eventually; one per user for MVP |
| 2026-09-06 | Q5 region | Best practice; default us-east-1 |
| 2026-09-06 | Q6 budgets | Configurable via TUI (`/cloud config`) |
| 2026-09-06 | Q7 attach UX | Full rich experience |
| 2026-09-06 | Q8 trust repo `.pi/` | Yes |
| 2026-09-06 | Q9 name/license | `pi-cloud-agents`, MIT |
| 2026-09-06 | Q10 test account / setup | None yet; ship an easy verifiable setup script + TUI verification |
| 2026-09-06 | Q11 start | Not yet; plan must be solid first |
| 2026-09-06 | R1 providers to sync | All currently configured providers (deselectable in `/cloud config`) |
| 2026-09-06 | R2 OAuth providers in VM | Opt-in per provider with ToS notice (gated on spike T0.6) |
| 2026-09-06 | R3 GitHub org / npm publisher | Deferred until release (T5.8) |
| 2026-09-06 | R4 real model prompt in verify | Yes — default on when a provider is synced; `--no-model` skips |
| 2026-09-06 | R5 secret store | Best practice: AWS Secrets Manager (+ optional customer-managed KMS key) |
| 2026-09-06 | UX additions | Professional TUI, no emoji (lint-enforced); live analytics proving cloud runs work (metrics, dashboard, status card); deployment as simple as possible (quick setup, ≤ 15 min first run, IAM helper) — see `07-ux-and-observability.md` |
| 2026-09-06 | Research verification pass | ADR-4 amended to controller-driven keepalive/suspend (AWS: no self-suspend); IMDSv2 credential exposure confirmed; `PassNetworkConnector`, trust-policy conditions, CFN `MicrovmImage` all-required properties, token TTL 60 min, image single-size and version storage cost, quick-create S3 requirement recorded — see `02-decisions.md §E` |
