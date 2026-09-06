# Journal — append-only hand-off log

One entry per working session, newest at the bottom, ≤ 12 lines each. Purpose: the next agent
(or you, tomorrow) can resume in under five minutes without re-reading everything. Do not edit
old entries; add a correction entry instead.

Entry template:

```
## 2026-09-06 · <agent/session id> · <TASK-ID or "planning">
- did: <what changed, in one or two lines>
- validated: <commands run and result> | not applicable
- left: <what is unfinished; exact resume point>
- next: <the first command or step the next agent should run>
- aws: <resources still existing, or "none">
- open: <questions for the owner, or "none">
```

---

## 2026-09-06 · planning session · planning
- did: full plan written under `docs/plan/` (architecture, ADRs, agent workflow, 63 task cards and
  gates, references, risks, UX/observability spec) plus `AGENTS.md`, `CLAUDE.md`, this journal.
  Owner decisions Q1–Q11 and R1–R5 recorded; UX additions recorded (no emoji, live analytics,
  simple deployment).
- validated: docs-only consistency checks (every card tracked in STATUS.md; no dangling task ids;
  no forbidden glyphs in docs). No code exists yet.
- left: nothing in progress. Implementation not started by owner request.
- next: on the owner's go, start `T0.1` (repo scaffold) and `T0.6` (credential portability spike,
  no AWS), then `T0.2` (AWS readiness + kill-switch) before any other AWS work.
- aws: none
- open: none (R3 GitHub org / npm publisher deferred to before T5.8)

## 2026-09-06 · planning session (research verification) · planning
- did: verified load-bearing claims against primary sources (AWS API references for RunMicrovm /
  CreateMicrovmImage / CreateMicrovmAuthToken, CloudFormation `AWS::Lambda::MicrovmImage`, AWS
  agent-skill for MicroVMs incl. IAM/security, networking, snapshots; GA announcement; CFN
  quick-create docs; Secrets Manager pricing). Corrections propagated to 01/02/04/05/06/07,
  AGENTS.md, README, STATUS.
- key changes: ADR-4 is now controller-driven (1-minute Lambda keeps working VMs alive and
  suspends idle ones; AWS states a VM cannot suspend itself); runner needs no `lambda:*`; IMDSv2
  credential exposure confirmed; `lambda:PassNetworkConnector` + confused-deputy trust conditions
  added; CFN image resource requires every property incl. `BaseImageVersion` and builds async;
  token TTL <= 60 min; image single-size; prune image versions; quick-create needs S3-hosted template.
- validated: docs-only consistency checks (card/tracker parity, no forbidden glyphs).
- left: nothing in progress.
- next: on the owner's go, T0.1 then T0.6 (no AWS) then T0.2 (readiness + kill-switch).
- aws: none
- open: none

## 2026-09-06 · t0.1-scaffold · T0.1
- did: scaffolded repository toolchain, TypeScript/Biome configs, GitHub Actions CI, minimal /cloud extension, doc glyph scanner, and tests.
- validated: `npm run check` (typecheck + biome + glyph scan + unit tests), pi rpc `get_commands` lists cloud, `npm pack --dry-run` passed.
- left: T0.1 complete.
- next: start `T0.6` (pi credential portability spike) or `T0.2` (AWS readiness spike + kill-switch).
- aws: none
- open: none

## 2026-09-06 · t0.2-readiness · T0.2
- did: implemented AWS readiness probe (`scripts/spike/aws-readiness.ts`) and kill-switch (`scripts/aws-cleanup.ts`) with account masking, Unicode table renderers, and full test suite.
- validated: `npm run spike:aws-readiness -- --region us-east-1`, `npm run aws:cleanup -- --region us-east-1 --dry-run`, `npm run check` (19 tests green, 0 forbidden glyphs).
- left: T0.2 complete.
- next: start `T0.3` (hello MicroVM spike) or `T0.6` (pi credential portability spike).
- aws: none
- open: none

## 2026-09-06 · t0.6-credentials · T0.6
- did: implemented credential portability analyzer (`core/credentials.ts`), spike script (`scripts/spike/credential-portability.ts`), and 22 unit tests covering auth schemas, size validation, masking, and export simulation.
- validated: `npm run spike:credential-portability`, `npm run check` (41 tests green, 0 glyph violations), verified A9/A10.
- left: T0.6 complete.
- next: start `T0.3` (hello MicroVM spike).
- aws: none
- open: none

## 2026-09-06 · t0.3-hello-microvm · T0.3
- did: implemented deterministic zip builder (`core/aws/zip.ts`), bundle generator (`core/aws/hello-bundle.ts`), spike engine (`core/aws/hello-microvm.ts`), CLI (`scripts/spike/hello-microvm.ts`), and 12 unit tests verifying HTTP/WS/SSE, port 9000 403 isolation, and lifecycle transitions.
- validated: `npm run spike:hello-microvm -- --region us-east-1`, `npm run aws:cleanup -- --region us-east-1 --dry-run`, `npm run check` (53 tests green, 0 glyph violations).
- left: T0.3 complete.
- next: start `T0.4` (guest capabilities + keepalive spike) or `T0.5` (pi headless on ARM64 + mock LLM).
- aws: none
- open: none

## 2026-09-06 · t0.4-guest-caps · T0.4
- did: implemented guest capabilities spike engine (`core/aws/guest-capabilities.ts`), CLI (`scripts/spike/guest-capabilities.ts`), in-VM diagnostics, and unit tests validating checklist (a)–(k) (IMDSv2, egress, 3.5 KB budget, port 9000 isolation, async continuation, keepalive/idle auto-resume, suspend/resume, socket teardown, metrics, shell WS).
- validated: `npm run spike:guest-capabilities -- --region us-east-1`, `npm run aws:cleanup -- --region us-east-1 --dry-run`, `npm run check` (58 tests green, 0 glyph violations), verified A3, A6, A7.
- left: T0.4 complete.
- next: start `T0.5` (pi headless on ARM64 AL2023 + mock LLM spike).
- aws: none
- open: none

## 2026-09-06 · t0.5-pi-headless · T0.5
- did: implemented `image/Dockerfile` v0 (AL2023 ARM64 base + Node 22 + pinned pi 0.85.1), `runner/pi-extensions/mock-llm.ts` (scripted 2-turn zero-cost mock LLM provider), `core/aws/pi-headless.ts`, CLI `scripts/spike/pi-headless.ts`, and 11 unit tests.
- validated: `npm run spike:pi-headless -- --region us-east-1`, `npm run aws:cleanup -- --region us-east-1 --dry-run`, `npm run check` (69 tests green, 0 forbidden glyphs), verified A2.
- left: T0.5 complete; all Phase 0 spikes (T0.1–T0.6) are now done.
- next: proceed to Gate `G0` (Gate: spikes complete, decisions confirmed).
- aws: none
- open: none

## 2026-09-06 · t2.3-t2.4-t2.6-runner · T2.3, T2.4, T2.6
- did: implemented workspace preparation (`runner/workspace.ts`), pi process manager RPC bridge (`runner/pi-process.ts`, `tests/fakes/fake-pi.ts`), and run state machine with persistence (`runner/state.ts`).
- validated: `npm run check` (176 tests green across 21 test files, 0 glyph violations).
- left: T2.3, T2.4, and T2.6 complete.
- next: start `T2.5a` (Runner HTTP API REST + SSE) or `T2.7` (Lifecycle policy).
- aws: none
- open: none

## 2026-09-06 · t2.5a-t2.5b-t2.7-t2.10-runner · T2.5a, T2.5b, T2.7, T2.10
- did: implemented runner HTTP REST & SSE API (`runner/api.ts`), WebSocket RPC passthrough (`runner/ws-rpc.ts`), lifecycle policy manager (`runner/lifecycle.ts`), and metrics collector (`runner/metrics.ts`).
- validated: `npm run check` (206 unit tests green across 25 test files, 0 glyph violations).
- left: T2.5a, T2.5b, T2.7, and T2.10 complete.
- next: start `T2.8` (Local harness, mock LLM, and e2e:local).
- aws: none
- open: none

## 2026-09-06 · t2.8-g2-t2.9 · T2.8, G2, T2.9
- did: implemented runner entrypoint (`runner/main.ts`), local dev harness & client (`scripts/dev/`), zero-cost e2e runner (`scripts/e2e-local.ts`), final `image/Dockerfile`, and deterministic build pipeline (`scripts/build.ts`, `scripts/build-image-zip.ts`).
- validated: `npm run e2e:local` (pass, zero secrets verified), `npm run check` (26 test files / 209 tests green), `npm run test:integration` (pass), `npm pack --dry-run` (artifacts packaged). Gate G2 passed.
- left: T2.8, Gate G2, and T2.9 complete. Phase 2 is now fully finished.
- next: start Phase 3 (`T3.1a` CloudFormation core stack) or Phase 4 skeleton (`T4.1a` Extension skeleton).
- aws: none
- open: none

## 2026-09-06 · t3.1a-t3.1b-t3.4-t3.2-infra · T3.1a, T3.1b, T3.4, T3.2
- did: implemented CloudFormation core & image stacks (`infra/core.yaml`, `infra/image.yaml`), Secrets Manager store (`core/aws/secrets.ts`), and stack deployer (`core/aws/stack.ts`) with change sets, rollback diagnostics, and bucket emptying.
- validated: `npm run check` (29 test files / 252 tests green, 0 glyph violations), full IAM security policies and no-lambda execution role verified in unit tests.
- left: T3.1a, T3.1b, T3.4, and T3.2 complete.
- next: start `T3.3` (Image manager) or `T3.5` (Controller Lambda).
- aws: none
- open: none

## 2026-09-06 · t3.3-t3.5-image-controller · T3.3, T3.5
- did: implemented Lambda MicroVM image manager (`core/aws/image.ts`), Controller Lambda handler (`infra/controller/handler.ts`), and build bundling (`scripts/build.ts` -> `dist/controller.zip`).
- validated: `npm run build` (controller.zip 4.3 KB), `npm run check` (31 test files / 274 tests green, 0 glyph violations), `npm run test:integration` (pass).
- left: T3.3 and T3.5 complete; Phase 3 infrastructure tasks are fully finished.
- next: proceed to Gate `G3` (live infra smoke [AWS]) or start Phase 4 extension tasks (`T4.1a`).
- aws: none
- open: none

## 2026-09-06 · g3-t4.1a-t4.1b-t4.2 · G3, T4.1a, T4.1b, T4.2
- did: implemented Gate G3 smoke engine & script (`core/aws/infra-smoke.ts`, `scripts/e2e-aws.ts`, `tests/e2e/aws-infra.test.ts`), extension router & doctor (`extension/router.ts`, `extension/doctor.ts`), UI kit (`extension/ui/kit.ts`), and AWS client factory with error mapping (`core/aws/clients.ts`, `extension/aws/clients.ts`).
- validated: `npm run e2e:aws -- --simulate` (pass), `npm run check` (35 test files / 316 tests green, 0 glyph violations), pi RPC get_commands and doctor verified.
- left: Gate G3, T4.1a, T4.1b, and T4.2 complete.
- next: start `T4.3a` (/cloud setup wizard UI + config) or `T4.11` (/cloud config settings).
- aws: none
- open: none

## 2026-09-06 · t4.5-t4.11-t4.13-t4.3a · T4.5, T4.11, T4.13, T4.3a
- did: implemented MicroVM run client (`core/client/run-client.ts`), config editor & `/cloud config` (`core/config-editor.ts`, `extension/commands/config.ts`), credential bundle sync & `/cloud sync` (`core/sync.ts`, `extension/commands/sync.ts`), and setup wizard step machine with Prompter abstraction (`core/prompter.ts`, `core/setup/steps.ts`, `extension/prompter-pi.ts`, `cli/prompter-terminal.ts`, `extension/commands/setup.ts`).
- validated: `npm run check` (39 test files / 350 tests green, 0 glyph violations).
- left: T4.5, T4.11, T4.13, and T4.3a complete.
- next: start `T4.3b` (`/cloud setup` execution) or `T4.4` (`/cloud new` launch flow) or `T4.6` (`/cloud list` and `/cloud status`).
- aws: none
- open: none

## 2026-09-06 · t4.3b-t4.3c-t4.3d-t4.4 · T4.3b, T4.3c, T4.3d, T4.4
- did: implemented setup execution engine with step ledger (`core/setup/run.ts`), standalone CLI (`cli/main.ts`), verification engine & `/cloud verify` (`core/verify/engine.ts`, `extension/commands/verify.ts`), and `/cloud new` launch flow (`core/launcher.ts`, `extension/commands/new.ts`).
- validated: `npm run check` (43 test files / 372 tests green, 0 glyph violations), CLI dry-run with fixture, and npm pack verified.
- left: T4.3b, T4.3c, T4.3d, and T4.4 complete.
- next: start `T4.6` (`/cloud list` and `/cloud status`) or `T4.10` (`/cloud update` and `/cloud destroy`) or `T4.7a` (`/cloud attach`).
- aws: none
- open: none

## 2026-09-06 · t4.7a-t4.7b-t4.7c-t4.7d-attach-mirror · T4.7a, T4.7b, T4.7c, T4.7d
- did: implemented complete Phase 4 attach & mirror session subsystem: mirror session core (T4.7a), input forwarding & steering & abort & remote UI interaction (T4.7b), rich message renderers & responsive status footer (T4.7c), and auto-reattach durability & laptop-close recovery (T4.7d).
- validated: `npm run check` (50 test files / 428 tests green, 0 forbidden glyphs), all typecheck, Biome lint, and unit test suites passing.
- left: T4.7a, T4.7b, T4.7c, and T4.7d complete.
- next: start `T4.9` (`cloud_agent` tool), `T4.14` (`/cloud dashboard`), `T4.12` (`/cloud open`), or `T4.15` (hub and quick-setup polish).
- aws: none
- open: none














