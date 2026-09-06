# 03 — Agent workflow: how to execute this plan

This plan is designed to be executed by coding agents (pi sessions) one task at a time. The
rules below are mandatory; they are what makes "validate before moving on" real.

`AGENTS.md` at the repo root is the agent operating manual (loaded automatically by pi): reading
order, **start-of-session and end-of-session rituals**, non-negotiable rules, conventions,
gotchas, and escalation. This document is the detailed gate protocol it points to. If they ever
disagree, fix both in the same commit.

## 1. Task selection

1. Open `docs/plan/STATUS.md`. A task is **ready** when every task in its `Depends on` list is
   `done` and its phase gate (if any precedes it) is `passed`.
2. Pick the lowest-numbered ready task unless the owner assigned one. Set it to `in-progress`
   with your session id and a timestamp. Only one task `in-progress` per agent.
3. Read, in order: the task card (`04-tasks.md`), ADRs it references (`02-decisions.md`), the
   architecture sections it touches (`01-architecture.md`), and the source facts it depends on
   (`05-references.md`). Do not re-research settled facts; if a fact seems wrong, verify against
   the primary source and record the correction in `05-references.md`.

## 2. Execution loop for one task

```
plan (≤ 6 lines in the evidence file)
 → implement in small commits
 → run every command in the card's "Validate" list, exactly as written
 → paste trimmed outputs into docs/evidence/<TASK-ID>.md
 → all pass?  yes → mark done, update STATUS.md, commit
               no → fix and re-run; if stuck > 2× the size estimate → mark blocked with reason
```

Hard rules:

- **Never mark a task `done` with a failing or skipped validation step.** Partial work stays
  `in-progress` or becomes `blocked`; create a follow-up card if scope must be cut.
- **Do not widen scope.** If you discover missing work, add a new card (next free id in that
  phase, e.g. `T2.10`) with dependencies, instead of folding it into the current task.
- **Size guard.** Cards are S (≤1 h), M (1–3 h), L (3–6 h). If a task is trending past 2× its
  size, stop, split it into sub-cards (`T4.3a`, `T4.3b`), and continue with the first.
- **Global "definition of done"** for every task, in addition to the card's own checks:
  - `npm run check` passes (typecheck + lint + unit tests) at the repo root;
  - no secrets, account ids, or tokens in code, docs, or evidence (use `<ACCOUNT_ID>`, `<TOKEN>`);
  - public behavior changes are reflected in docs (`README.md`, `docs/protocol.md`, or the card);
  - `STATUS.md` updated; commit message `type(TASK-ID): summary` (e.g. `feat(T2.4): pi process manager`).

## 3. Live-AWS tasks (extra rules)

Tasks marked **[AWS]** touch a real account. Until a dedicated test account exists (owner
decision Q10), that account is the **owner's own** — so these rules are strict. They must:

- run only with `PI_CLOUD_E2E=1`, `AWS_PROFILE=$PI_CLOUD_TEST_PROFILE`, region `us-east-1`
  unless the card says otherwise, and a stack/image name that starts with `pi-cloud-agents-test`;
- have the kill-switch available first: `npm run aws:cleanup -- --region us-east-1` (T0.2) must
  exist and be run at the end of every [AWS] session, and immediately if anything goes wrong;
- tag every created resource `pi-cloud-agents:test=true` (where tags are supported) and set
  `maximumDurationInSeconds ≤ 3600` on every test MicroVM;
- end with the **cleanup verification block** in the evidence file:
  ```
  aws lambda-microvms list-microvms --region <R>            # expect: no non-TERMINATED items for the test image
  aws cloudformation describe-stacks --stack-name <S>       # expect: DELETE_COMPLETE or does-not-exist (when the task deletes)
  aws s3 ls s3://<bucket>/runs/                             # expect: empty (when the task deletes)
  aws secretsmanager list-secrets --filters Key=name,Values=pi-cloud-agents/<S>/   # expect: [] (after destroy)
  ```
  If cleanup fails, the task is `blocked` until fixed — an orphaned VM costs money every second.
- record timings (image build, launch→RUNNING, ready, suspend, resume) and an estimated cost.

## 4. Evidence file template (`docs/evidence/<TASK-ID>.md`)

```markdown
# <TASK-ID> — <title>
- Agent/session: <id>   Started: <ISO>   Finished: <ISO>   Size est/actual: M / 2h10m
## Plan
- ...
## Changes
- files: ...
## Validation
### <command 1 exactly as in the card>
<trimmed output (≤ 40 lines), exit code>
### <command 2>
...
## AWS cleanup verification   (only for [AWS] tasks)
...
## Notes / follow-ups
- new cards created: ...
- deviations from the card and why: ...
```

## 5. Gates

Phase gates (`G0`…`G5` in `04-tasks.md`) are integration checkpoints. A gate is `passed` only
when its script/checklist passes **and** the owner (or a reviewer agent) has read the evidence.
No task from a later phase may start before the preceding gate passes, except tasks explicitly
marked `[parallel-ok]`.

Every gate review also checks that `AGENTS.md` (commands, conventions, gotchas) and
`docs/plan/JOURNAL.md` are current, and that `STATUS.md` has no stale `in-progress` rows.

## 5a. Hand-offs and resuming

- Append a `JOURNAL.md` entry at the end of every session (template inside the file): did,
  validated, left, next, aws, open. This is the primary resume mechanism.
- Resuming an `in-progress` task left by another agent: allowed only if its evidence/journal has
  not been updated for > 24 h; note the takeover in JOURNAL.md, re-run the card's validation for
  the parts marked done, and continue from the recorded resume point.
- If the repository state does not match STATUS/JOURNAL (red `npm run check`, dirty tree,
  missing evidence), reconcile and document before new work.

## 6. Escalate to the owner when

- a spike result contradicts an ADR (e.g. self-heartbeat impossible) → propose the ADR change;
- a live test produced unexpected cost (> $5) or left resources you could not delete;
- a security concern is found (credential exposure path, IAM policy needing `*`);
- an open question in `02-decisions.md §C` blocks the task and the default is unsafe.

Otherwise proceed with the documented defaults and note the assumption in the evidence file.

## 7. Working conventions

- TypeScript strict; no `any` in `shared/`; zod schemas are the single source of truth for
  payloads and manifests (JSON schema is generated, not hand-written).
- Tests live next to code (`*.test.ts`); integration tests under `tests/integration`; e2e under
  `tests/e2e` (env-gated). Fakes over mocks where possible (`FakeSecretsProvider`,
  `LocalStorageSink`, `FakePiProcess`).
- Every network client has a timeout and a retry policy; every long-running loop has a deadline.
- Logs are structured JSON with a `redact()` pass; secret values are registered at load time.
- Follow pi docs for extension code: `promptGuidelines` must name the tool; use `StringEnum` for
  enums; truncate tool output (50 KB / 2000 lines); guard TUI-only APIs with `ctx.hasUI`/`ctx.mode`.
- `core/` must never import from `@earendil-works/pi-coding-agent` at runtime (it is shared with
  the CLI); pi-specific adapters live in `extension/`. A lint rule enforces this.
- **UI rules are non-negotiable** (`07-ux-and-observability.md`): no emoji anywhere (the
  `ui-style` test is part of `npm run check`), only the allowed glyph set, pi theme colors only,
  all tables/badges/durations through `extension/ui/kit.ts`, every screen snapshot-tested at
  80/120 columns, errors formatted as what/why/next. A card that adds UI is not `done` without
  its snapshot tests and a passing style lint.
- Metrics shown to users must come from real measurements (no placeholders, no defaults that
  look like data); omit what cannot be measured.
- Anything a user could do from the TUI setup path must be possible from the CLI path and vice
  versa (same `core/` step machines); parity is checked in T4.3c tests.
