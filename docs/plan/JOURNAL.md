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

## 2026-09-06 · t1.1-protocol · T1.1
- did: verified G0 checklist; implemented Zod schemas for LaunchPayload, RunManifest, RunnerStatus, SSE/error envelopes in `shared/protocol.ts`, JSON schema generator `scripts/gen-schemas.ts`, and `docs/protocol.md` spec.
- validated: `npm run schemas:gen && git diff --exit-code docs/schemas`, `npm run check` (86 tests green, 0 forbidden glyphs).
- left: G0 passed and T1.1 complete.
- next: start `T1.2` (local and per-repo config schemas), `T1.3` (Runner API contract doc), `T1.4` (pi config bundle builder), or `T2.1` (lifecycle hook server).
- aws: none
- open: none






