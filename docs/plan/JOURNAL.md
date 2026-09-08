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



