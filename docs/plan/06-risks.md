# 06 — Risk register and plan-solidity review

## A. Risks that only a spike can settle (Phase 0 exists for these)

| # | Risk | Impact if true | Resolved by | Mitigation / fallback |
|---|---|---|---|---|
| R-1 | Idle detection counts only inbound proxy traffic; a working agent with no client looks idle | agent suspended mid-task | **Settled by research** (ADR-4): controller Lambda polls `/v1/status` every minute (keepalive) and applies the idle policy from outside; platform idle policy kept as a safety net; T0.4 measures timings | if 1-minute cadence proves too coarse, poll every 30 s (two runs per invocation) |
| R-2 | Guest cannot suspend itself | self-suspend design impossible | **Refuted by AWS docs** ("No self-suspend from inside the MicroVM") | design already controller-driven; runner never needs `lambda:*` |
| R-2b | Controller Lambda fails silently (misconfigured schedule, throttled) → VMs never suspend | idle VMs bill until the safety-net idle policy (20 min) or max duration | G3 observes `controller/last-run.json` | dashboard/verify show controller age; platform idle policy + `maximumDurationInSeconds` bound the damage |
| R-3 | Run-hook payload limit is 4 KB (not 16 KB) | payload design must stay tiny | T0.4 | payload already carries references only; budget 3.5 KB; overflow → put launch spec in S3 and pass its key |
| R-4 | OAuth credentials are not portable / refresh conflicts between laptop and VM | subscription providers unusable in VMs | T0.6 | opt-in only; token broker (T5.9); Bedrock/API keys unaffected |
| R-5 | pi does not run on the ARM64 al2023-minimal base (Node/openssl/jiti quirks) | image redesign | T0.5 | use official Node arm64 tarball; different container base via `FROM`; document |
| R-6 | Image build disk (~7 GB) too small for a "rich" toolchain image | limited default toolchain | T0.5 | lean base image; per-repo `install` at launch; per-repo Builds (T6.1) |
| R-7 | Hooks port/behavior differs from docs (delivered on 9000 regardless) | hook server misconfigured | T0.3 | bind 9000 always; keep hooks off the client token port |
| R-8 | Credentials delivery in guest differs (env vs endpoint) | runner/pi SDK auth path | **Settled**: IMDSv2 per AWS docs; T0.4 confirms from an unprivileged process | pi and AWS SDKs use the default chain; threat model updated (any guest process can read the role) |
| R-9 | CloudFormation `MicrovmImage` reports CREATE_COMPLETE before the build finishes, or fails to stabilize on update | setup declares success too early; smoke run fails | G3 | deployer always polls `GetMicrovmImage`; SDK image management fallback (ADR-3) |

## B. Product / execution risks

| # | Risk | Mitigation in plan |
|---|---|---|
| P-1 | Orphaned MicroVMs burn money (no test account, owner's account used) | kill-switch script before any [AWS] task; `maximumDurationInSeconds` on every VM; controller from G3; cleanup verification block mandatory; spikes cap 30 min |
| P-2 | Rich mirror UX under-delivers (feels like a log tail) | T4.7c renderer bar reviewed by owner; `/cloud open` gives fully native rendering as a complement; G4 acceptance includes the laptop-close scenario |
| P-2b | TUI looks amateurish (emoji, misaligned tables, hard-coded colors) | `07-ux-and-observability.md` design rules; shared UI kit (T4.1b); lint that fails the build on emoji; snapshot tests at 80/120 cols in both themes; owner sign-off in G4 |
| P-2c | Users cannot tell whether anything is happening in the cloud | runner metrics (T2.10) surfaced in list/status/dashboard/footer with live "last event" ages, timelines, VM ids and regions; verify report with measured timings; dashboard shows last results even when idle |
| P-2d | Setup too hard for a typical pi user | quick-setup default (one screen), permission preflight with least-privilege policy + quick-create link, resumable steps, `≤ 15 min` first-run test by a non-implementer (T4.15), README quickstart written for first-time users |
| P-3 | Attach state drifts (duplicates/missing entries after reconnect) | durable cursor = remote entry id; idempotent appends; T4.7d tests kill SSE / restart host / 502 resume |
| P-4 | Secrets leak into transcripts/archives | secrets only in `auth.json`/env inside the VM; runner log redaction (T2.2); in-VM redaction extension (T5.1); grep tests in e2e |
| P-4b | "Sync all providers" widens exposure: every synced credential is readable by agent code in any VM | documented in wizard + README; `/cloud config` deselect; `/cloud doctor` lists synced providers; Secrets Manager versioning + CloudTrail for audit; rotation guidance |
| P-5 | Setup fails half-way on a user's account and leaves a mess | idempotent change-set deploys, step ledger, `setup` resumable, `destroy` complete, `verify` proves state |
| P-6 | IAM policy too broad or too narrow | `docs/iam.md` + policy test forbidding `*` resources; AccessDenied mapper tells users exactly what is missing |
| P-7 | 8-hour hard cap ends long tasks | T-15 min warning + checkpoint; `/cloud continue` (T5.3) |
| P-8 | pi API/version drift between local pi and in-VM pi | pin pi in image; `doctor` reports drift; `update` rebuilds; peerDependencies `*` for the extension |
| P-9 | Scope creep (team mode, web UI, triggers) delays MVP | Phase 6 backlog; ADR-2 keeps data layout team-ready without building it |
| P-10 | Cost surprises for users | cost table in docs, per-run estimate in `/cloud list`, budget guard (T5.4), verify smoke run uses mock LLM |

## C. Plan-solidity checklist (for the owner's review)

- [ ] Every MVP capability in `01-architecture.md §1` maps to at least one task card.
- [ ] Every ADR is Accepted, or has a spike task that verifies it (ADR-4 → T0.4, ADR-5 → T0.6, ADR-3 → T3.1b).
- [ ] Every task has: dependencies, size, deliverables, executable validation, done criteria.
- [ ] Every [AWS] task ends with the cleanup verification block; a kill-switch exists before the first one.
- [ ] Gates G0–G5 each have a checklist and an owner sign-off step.
- [ ] Security: threat model, IAM review, secret redaction, and a security CI job are scheduled before release.
- [ ] Setup is shippable both as TUI and CLI and is verified by a real smoke run.
- [ ] The laptop-close/reopen scenario is an explicit acceptance test (G4 step 3).
- [ ] All provider support is delegated to pi's own runtime (no custom auth layer), with OAuth gated by a spike.
- [ ] UI/observability/simplicity requirements have a spec (`07-ux-and-observability.md`), enforcing
      tests (style lint, snapshots), tasks (T2.10, T4.1b, T4.6, T4.14, T4.15) and a gate check (G4 §5).
- [x] Remaining questions R1–R5 answered (2026-09-06).

When every box is checked, Phase 0 can start on the owner's go.
