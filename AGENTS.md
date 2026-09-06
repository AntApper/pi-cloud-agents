# AGENTS.md — operating manual for agents working on pi-cloud-agents

You are working on **pi-cloud-agents**: a pi package that gives pi users cloud agents (autonomous
pi sessions in Firecracker-isolated AWS Lambda MicroVMs in the user's own AWS account), with a
rich local mirror, verified one-command setup, and a professional TUI. Everything you need is in
this repository. Read this file fully before doing anything; it is short on purpose and links to
the detail.

## 1. Source of truth (read in this order when you start)

1. `docs/plan/STATUS.md` — what is done, in progress, blocked; owner decisions log.
2. `docs/plan/JOURNAL.md` — the last few hand-off notes (what the previous agent did and left).
3. `docs/plan/04-tasks.md` — the task card you will work on (dependencies, validation, done criteria).
4. `docs/plan/02-decisions.md` — ADRs and the owner's decisions. **Never contradict an Accepted ADR
   silently**; propose a change instead (see §9).
5. `docs/plan/01-architecture.md`, `docs/plan/07-ux-and-observability.md` — how the system and the
   UI are meant to look and behave.
6. `docs/plan/03-agent-workflow.md` — the gate protocol (validate before done, evidence, AWS rules).
7. `docs/plan/05-references.md` — verified facts about AWS MicroVMs, Cursor, and pi. Do not
   re-research these; if one looks wrong, verify against the primary source and correct the file.
8. `docs/plan/06-risks.md` — known risks and the plan-solidity checklist.

When documents disagree: owner decisions in STATUS/02 win, then the task card, then 01/07.
Fix the inconsistency you found as part of your task and mention it in the evidence file.

## 2. Start-of-session ritual (every time, even for a "quick fix")

```
1. git status && git log --oneline -5          # clean tree? on the expected branch?
2. read docs/plan/STATUS.md + the last 3 JOURNAL.md entries
3. pick a task: lowest-numbered `ready` card whose deps are `done` and whose phase gate passed,
   unless the owner assigned one. Reclaim an `in-progress` task only if its last evidence/journal
   update is > 24 h old; say so in JOURNAL.md.
4. mark it in-progress in STATUS.md (your session id, timestamp); commit that change.
5. read the card, then the ADRs/sections it references; write a ≤ 6-line plan in
   docs/evidence/<TASK-ID>.md (template in 03-agent-workflow.md §4).
6. npm run check                                # must be green before you change anything
7. if any [AWS] work happened recently: PI_CLOUD_E2E=1 npm run aws:cleanup -- --region us-east-1 --dry-run
   (once T0.2 exists) — confirm nothing is running that should not be.
```

If the world does not match the docs (tests red, dirty tree, STATUS says in-progress but nothing
in evidence), **reconcile first** and record what you found in JOURNAL.md. Do not build on sand.

## 3. End-of-session ritual (never skip; this is how the next agent makes progress)

```
1. all validation commands of the card re-run and pasted (trimmed) into docs/evidence/<TASK-ID>.md
2. STATUS.md row updated (done | in-progress with a "resume from" note | blocked with reason)
3. JOURNAL.md: append a dated entry (≤ 12 lines): task, what changed, what is left, next command
   to run, open questions, any AWS resources that still exist (should be none)
4. commit: type(TASK-ID): summary   (e.g. feat(T2.4): pi process manager)   — small commits, no WIP dumps
5. for [AWS] sessions: the cleanup verification block (03 §3) is in the evidence file
```

Leaving work half-done is fine. Leaving it **undocumented** is not.

## 4. Non-negotiable rules

- **Validate before done.** A card is `done` only when every item in its *Validate* list passed
  and `npm run check` is green. No exceptions, no "will fix in the next task".
- **One task at a time, in scope.** New work → new card (`T<phase>.<next>`), not scope creep.
  If a task passes 2× its size estimate, stop and split it.
- **Money and safety first (AWS).** Kill-switch before any AWS work; every MicroVM gets
  `maximumDurationInSeconds`; test resources are named `pi-cloud-agents-test*` and tagged; every
  AWS session ends with the cleanup verification block. An orphaned VM is a `blocked` task until
  it is gone. Use the owner's profile only via `PI_CLOUD_E2E=1` + `AWS_PROFILE=$PI_CLOUD_TEST_PROFILE`.
- **Secrets never touch the repo or evidence.** No keys, tokens, account ids, ARNs with account
  ids, or `auth.json` contents in code, docs, logs, commits, or evidence (`<ACCOUNT_ID>`, `<TOKEN>`).
  Run-hook payloads carry secret *names*, never values.
- **No emoji, anywhere.** Not in the TUI, CLI, logs, docs, commit messages, or this file. Only the
  glyphs in `07-ux-and-observability.md §1.1`. The `ui-style` test fails the build otherwise.
- **Real data only.** Metrics, timings, and status shown to users come from measurements; omit
  what cannot be measured. Never placeholder numbers that look like data.
- **Follow pi and AWS facts from `05-references.md`.** If you need a new fact, read the primary
  source (pi docs are installed with pi: `npm root -g`/@earendil-works/pi-coding-agent/docs; AWS
  docs online), record it in `05-references.md` with the source, then use it.
- **Do not change an Accepted ADR in code.** Write the proposal (§9) and continue with the
  documented behavior or block.

## 5. Repository map and commands

```
core/        pi-runtime-free engine (AWS ops, setup, verify, run client, pi-config bundle, prompter)
extension/   pi extension: /cloud commands, cloud_agent tool, mirror session, UI kit, renderers
cli/         npx pi-cloud-agents setup|verify|doctor|update|destroy (terminal prompter over core/)
runner/      in-VM runtime: hooks, pi RPC bridge, API, state/persistence, lifecycle, metrics
shared/      zod schemas (protocol, manifest, config) — single source of truth; JSON schema generated
image/       Dockerfile for the MicroVM image (ARM64, al2023-minimal base, pinned pi)
infra/       CloudFormation core.yaml + image.yaml, controller Lambda (keepalive/idle/janitor), IAM policy docs
scripts/     build-image-zip, dev harness (run-local, client), spikes, aws-cleanup (kill-switch)
tests/       unit (next to code too), integration (fake pi / fake proxy), e2e (env-gated)
docs/        plan/, protocol.md, iam.md, threat-model.md, evidence/, schemas/, testing/
dist/        build output shipped in the npm tarball (image/app.zip, controller.zip, runner bundle)
```

| Command | Use |
|---|---|
| `npm run check` | typecheck + lint (incl. `ui-style`, core-isolation rule) + unit tests; must be green before and after your change |
| `npm run test:unit` / `npm run test:integration` | vitest suites |
| `npm run build` | runner bundle, deterministic `dist/image/app.zip`, `dist/controller.zip` |
| `npm run e2e:local` | full local run with fake hooks + mock LLM (Gate G2) — zero cost, no AWS |
| `PI_CLOUD_E2E=1 npm run e2e:aws -- <suite>` | live AWS (G3/G4). Cleanup is mandatory |
| `npm run aws:cleanup -- --region us-east-1 [--dry-run] [--all]` | kill-switch for test resources |
| `npm run spike:<name>` | one-off spike scripts (Phase 0) |
| `pi --no-extensions -e ./extension/index.ts --mode rpc --no-session` | load the extension headless for quick checks |

Until T0.1 lands, these commands do not exist yet; T0.1 creates them exactly as named.

## 6. Engineering conventions

- TypeScript strict; no `any` in `shared/` or `core/`; zod schemas are the source of truth for
  every payload/manifest/config (generate JSON schema, never hand-write it).
- `core/` must not import `@earendil-works/pi-coding-agent` at runtime (shared with the CLI);
  pi adapters live in `extension/`. Lint enforces it.
- Fakes over mocks: `FakeSecretsProvider`, `LocalStorageSink`, `FakePiProcess`, fake proxy,
  `mock-llm` provider extension. Unit tests never touch the network. Live tests are env-gated.
- Every network call has a timeout and a bounded retry with jitter; every loop has a deadline;
  every long-running loop is cancellable via `AbortSignal`.
- Logs are structured JSON through the runner logger with `registerSecret()` redaction.
  Errors shown to users follow *what failed → why (code) → what to do next*. No stack traces in UI.
- Deterministic artifacts: fixed mtimes and ordering in zips/tars; content-addressed S3 keys.
- All UI output goes through `extension/ui/kit.ts` (tables, badges, durations, sparklines);
  snapshot tests at 80 and 120 columns in dark and light themes for every screen.
- Tests live next to code (`*.test.ts`); integration under `tests/integration`; e2e under
  `tests/e2e`. Name fixtures for what they prove.
- Conventional commits with the task id: `feat(T4.6): status detail card`, `fix(T2.4): LF framing`.

## 7. pi facts and gotchas you will hit (details in `05-references.md`, pi docs)

- Extensions are TypeScript loaded by jiti; package manifest `"pi": {"extensions": [...]}`;
  runtime deps in `dependencies`; pi packages as `peerDependencies "*"`.
- Guard UI with `ctx.hasUI` (dialogs/notify) and `ctx.mode === "tui"` (`ctx.ui.custom`, footer,
  overlays). RPC mode has no `custom()`.
- `promptGuidelines` bullets must name the tool ("Use cloud_agent when…"); use `StringEnum` for
  enums (Google compatibility); truncate tool output (50 KB / 2000 lines).
- Custom **entries** (`pi.appendEntry` + `registerEntryRenderer`) never enter LLM context — use
  them for mirrored remote messages. Custom **messages** (`pi.sendMessage`) do enter context.
- After `ctx.newSession/switchSession/fork`, use only the `withSession` ctx; old `pi`/`ctx` are stale.
- pi RPC is **LF-delimited JSONL** — never use `readline` (it splits on U+2028/2029). `RpcClient`
  is exported from the pi package.
- `input` events expose `streamingBehavior` (`steer` | `followUp` | undefined) — that is how the
  mirror maps local input to remote prompt/steer/follow-up.
- Non-interactive pi (`--mode rpc`) uses `defaultProjectTrust`/`--approve` for repo `.pi/` config.
- Extension factories must not start background resources; start them on `session_start`, stop
  them on `session_shutdown` (idempotent).
- Read the pi docs before using an API you have not used in this repo: `docs/extensions.md`,
  `docs/tui.md`, `docs/rpc.md`, `docs/sdk.md`, `docs/session-format.md`, `docs/packages.md`.

## 8. AWS Lambda MicroVM facts and gotchas (details in `05-references.md`)

- ARM64 only; 8-hour hard lifetime (`maximumDurationInSeconds` ≤ 28,800) covering running +
  suspended; sizes 0.5–8 GB baseline with 4× burst; image build ≈ 2–3 min on a ~7 GB build disk.
- **Idle = no inbound proxy traffic, and a VM cannot suspend itself** (AWS docs). The controller
  Lambda polls `/v1/status` every minute (keepalive) and calls `SuspendMicrovm`/`TerminateMicrovm`
  from outside (ADR-4). The runner never needs `lambda:*`. The platform idle policy is only a
  safety net; if present all three fields are required.
- **Execution-role credentials are readable by every guest process** via IMDSv2
  (`169.254.169.254/latest/meta-data/iam/security-credentials/execution_role`) — treat the guest as
  untrusted and keep the role minimal.
- Every `RunMicrovm` needs **`lambda:PassNetworkConnector`** (even for default connectors);
  `imageIdentifier` must be the image **ARN**; pass an explicit `imageVersion`.
- Hook timeouts default to **1 s** for run/resume/suspend/terminate — always set explicit values.
  All outbound connections are killed on run and resume; retry after `/resume`.
- Auth tokens live ≤ 60 min (we use 30 and refresh at T-5); shell access is a WebSocket to
  `wss://<endpoint>/shell` with the `lambda-microvms.port.8022` subprotocol.
- An image has one memory size; unused image versions still cost storage (prune on `update`).
- Hooks: `/aws/lambda-microvms/runtime/v1/{ready,validate,run,resume,suspend,terminate}` on
  **port 9000**, bound to `0.0.0.0`; `/run` must answer 200 fast (≤ 60 s, aim < 1 s) and do heavy
  work asynchronously; hooks may be retried — make them idempotent; implement `/ready` if you use
  any MicroVM hook.
- Run-hook payload is small (budget 3.5 KB) — references only. Image env vars need a rebuild.
- Inbound needs `X-aws-proxy-auth` (JWE token from `CreateMicrovmAuthToken`, port-scoped, expiring)
  and `X-aws-proxy-port`; WebSocket uses subprotocols. Client tokens are scoped to 8080 only.
- Outbound UDP is blocked by default; DNS goes through the platform stub.
- Any process in the guest can obtain execution-role credentials → keep the role minimal; treat
  the guest as untrusted.
- Rate limits: `RunMicrovm` 5 TPS, `SuspendMicrovm` 2 TPS — back off with jitter.

## 9. Deciding, escalating, and changing course

Proceed on your own when: the task card and ADRs cover the situation, or a documented default
applies (record the assumption in the evidence file).

Stop and write to the owner (a `blocked` row + a JOURNAL entry + a section "Proposal" in the
evidence file) when: a spike contradicts an ADR; a live test cost > $5 or left resources you
could not delete; you found a credential-exposure path or need an IAM `*` resource; the only way
forward changes user-visible behavior not covered by the plan; a dependency (pi API, AWS API) does
not behave as documented in `05-references.md` and the fix is architectural.

To change an ADR: add a "Proposed amendment" under the ADR in `02-decisions.md` with context,
options, recommendation, and impacted cards; do not implement the amendment until Accepted.

## 10. Quality bar — what "good" looks like here

- A user with pi and an AWS account gets a working cloud agent in ≤ 15 minutes from the README.
- Every screen looks like pi built it: theme colors, aligned columns, no emoji, quiet and dense.
- The user can always answer "is it working?" from the TUI: live last-event age, timeline,
  tokens, cost, VM id + region, verify report with measured timings.
- Closing the laptop never loses a run; reopening pi shows the live cloud session again.
- No orphaned AWS resources, ever; `destroy` leaves nothing; costs are visible and labeled "est.".
- Secrets are only ever in Secrets Manager and inside the VM's `~/.pi/agent`; redacted elsewhere.

Anti-patterns that get a change rejected: emoji or hand-built string tables in UI; metrics with
placeholder values; `any` in shared/core; unbounded polls or retries; tests that hit the network
without the e2e gate; a `done` row without evidence; scope folded into an unrelated task; secrets
or account ids in the repo; deviating from an ADR without a proposal; `readline` on RPC streams.

## 11. Glossary

**run** — one cloud agent execution (one MicroVM, one manifest, one work branch `pi-cloud/<runId>`).
**VM** — the Lambda MicroVM. **runner** — our in-VM service. **mirror session** — the local pi
session bound to a run. **attach/detach** — connect/disconnect the mirror. **bundle** — the user's
synced pi config (auth entries + models.json + settings subset + AGENTS.md). **stack** —
`pi-cloud-agents-core` / `-image` CloudFormation stacks. **controller** — the 1-minute scheduled
Lambda that keeps working VMs alive, suspends idle ones, and cleans up (formerly "janitor"). **gate (G0–G5)** — phase checkpoints requiring owner/reviewer sign-off. **evidence** —
`docs/evidence/<TASK-ID>.md` with validation output. **kill-switch** — `npm run aws:cleanup`.

## 12. Keeping this file useful

Update this file whenever a convention, command, or gotcha changes; every gate review checks
that `AGENTS.md` and `JOURNAL.md` are current. Keep it under ~250 lines: it is loaded into every
session. Put details in `docs/`, not here.
