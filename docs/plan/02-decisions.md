# 02 — Decisions, assumptions, open questions

Status legend: **Proposed** (needs owner confirmation) · **Accepted** (owner confirmed) ·
**Verified** (confirmed by spike) · **Refuted** (spike disproved; ADR amended).

Owner answers recorded 2026-09-06 (see §C and `STATUS.md` decisions log).

## A. Architecture decision records

### ADR-1 — The agent loop runs inside the MicroVM; the local pi mirrors it — Accepted
- Context: Cursor hosts the agent loop; we have no hosted service. Owner requirement: the run
  keeps going when the laptop closes, and when pi is reopened the **active cloud session shows
  up again** exactly where it is.
- Decision: `pi --mode rpc` runs inside the VM. Locally, a cloud run is represented by a
  **mirror session**: a real pi session file bound to the run, showing the remote transcript,
  live streaming, remote model/cost/context stats, and forwarding input. Mirror sessions
  reconnect automatically on pi startup / `/resume` / network return, replaying from a durable
  cursor and transparently resuming a suspended VM.
- Consequences: reconnect + replay + suspended-VM resume paths are MVP (T4.7a–d); footer/status
  must reflect remote state in every session (`cloud 2 running`); a "hybrid mode" (local brain,
  cloud hands) stays a later option (T6.2).

### ADR-2 — No custom control plane; direct AWS SDK + a small controller Lambda; team-ready data layout — Accepted (amended 2026-09-06)
- Decision: the extension/CLI call AWS APIs directly. The only always-on component is a
  **controller Lambda on a 1-minute schedule** that (a) keeps working VMs alive by polling their
  status endpoint (inbound traffic is the platform's only activity signal), (b) applies the idle
  policy from outside (suspend/terminate — AWS documents that a VM cannot suspend itself),
  (c) performs janitor duties (orphans, expired runs, run-scoped secrets), and (d) records a
  heartbeat the dashboard/verify show ("controller ran 40 s ago"). Run registry = S3 manifests. MVP tenancy: **one stack per user**, but
  the data layout is team-ready: manifests carry `owner` (caller identity ARN), `OperatorPolicy`
  is attachable to many principals, S3 keys are `runs/<runId>/…` with owner tags, and nothing
  assumes a single principal. Team mode (shared stack, per-user scoping) is T6.3.

### ADR-3 — Everything deployed by our code via CloudFormation (two stacks) — Accepted (verified 2026-09-06)
- `core` (bucket, roles, logs, operator policy) and `image` (MicrovmImage, controller). The
  `AWS::Lambda::MicrovmImage` resource exists and exposes every property we need (hooks, env vars,
  memory baseline, CPU architecture, logging, tags) — but **every property is required**, including
  `BaseImageVersion` (the deployer resolves the latest managed base version and passes it), and the
  build is asynchronous (the deployer polls `GetMicrovmImage` until the version is `SUCCESSFUL` +
  `ACTIVE` after the stack operation). SDK image management stays as the fallback if CloudFormation
  stabilization proves unreliable in G3. No Docker/AWS CLI required on the user's machine.

### ADR-4 — Keepalive and idle handling are controller-driven — Accepted (amended 2026-09-06 from research)
- Facts (AWS agent-skill "Known constraints"): idle is measured only by inbound proxy traffic;
  **"No self-suspend from inside the MicroVM — call `SuspendMicrovm` from outside"**; auth tokens
  live ≤ 60 min. Former strategy B (self-suspend) is therefore **Refuted** without a spike.
- Decision (default design, no spike needed): the **controller Lambda runs every minute**; for
  each RUNNING VM it mints a token, `GET /v1/status` (this is the activity signal that keeps a
  working agent alive), and applies policy from the manifest: agent settled and no attached client
  for `idleGraceSec` → `SuspendMicrovm`; run `finished|failed` past grace → `TerminateMicrovm`;
  age > `maxDuration + 10 min` or no manifest after 20 min → terminate. Suspended VMs are left
  alone; a returning client's request auto-resumes them. Each VM still gets a platform
  `idlePolicy` as a **safety net** (`maxIdleDurationSeconds` = 20 min, `suspendedDurationSeconds`
  = configured terminate-after-suspended, `autoResumeEnabled: true`) so nothing runs forever if
  the controller is broken, plus `maximumDurationInSeconds` always.
- Consequences: the runner needs no `lambda:*` permissions and no self-suspend code (smaller
  execution role, better threat model); the attached client also polls `/v1/status` every 60 s
  (RTT metric + traffic). Former strategy A (runner heartbeats its own public endpoint while
  streaming) is tested in T0.4 only as an **optional optimization** that would let the controller
  run at 5-minute cadence; the 1-minute controller is the shipped default either way.

### ADR-5 — LLM auth = the user's own pi credentials, synced securely to the VM — Accepted (amended)
- Owner: "support everything pi supports; don't remake it, use what exists in pi."
- Decision: the VM's pi is configured like the user's pi. At setup (and on demand via
  `/cloud sync`), the extension builds a **pi config bundle**: **all providers currently
  configured on the user's machine** (owner decision R1) — API keys resolved via
  `ctx.modelRegistry.getProviderAuth()` (covers `/login` keys and env-var keys); OAuth providers
  only when opted in per provider (R2) — plus `models.json` (custom providers/models), a settings
  subset (default model/thinking, compaction, retry), and the global `AGENTS.md`. Users can
  narrow the provider list in `/cloud config`. Secrets go to **AWS Secrets Manager**
  (`pi-cloud-agents/<stack>/pi-auth/<provider>`, KMS-encrypted; owner decision R5 = best
  practice); non-secret config goes to S3 `config/<owner>/bundle.tar`. The runner assembles
  `~/.pi/agent/{auth.json,models.json,settings.json,AGENTS.md}` in the VM before starting pi.
  **Amazon Bedrock via the execution role** remains the zero-secret path (pi resolves ambient
  AWS credentials).
- Exposure note (consequence of "sync all"): every synced credential is readable by agent code
  in every VM. Docs and the wizard say so; `/cloud config` can deselect providers; `/cloud doctor`
  lists what is synced; users should rotate keys if a run is suspected compromised.
- Risk: OAuth providers (Claude Pro/Max, ChatGPT/Codex, Copilot) rotate refresh tokens; two pi
  installs sharing one credential may invalidate each other. **Spike T0.6** measures this per
  provider. If refresh conflicts occur, T5.9 adds a local **token broker** (the local pi refreshes
  and republishes short-lived access tokens; the VM never refreshes). OAuth providers are
  **opt-in per provider with a ToS notice** (owner decision R2); subscription ToS for use inside
  a VM is the user's responsibility.
- Secret store (R5, best practice): **AWS Secrets Manager** for every credential (pi auth
  entries, GitHub token, run-scoped tokens) — dedicated secrets service, 64 KB values, versioning,
  resource policies (useful for team mode), CloudTrail data events; encrypted with the AWS-managed
  `aws/secretsmanager` key by default, optional customer-managed KMS key (`KmsKeyArn` stack
  parameter, `/cloud config`). SSM Parameter Store (standard tier) is used only for **non-secret**
  operational values. Cost transparency: ≈ $0.40 per secret per month (typically 3–10 secrets);
  run-scoped secrets are deleted with `ForceDeleteWithoutRecovery` by the controller/`stop`.
- The run-hook payload still carries **references only** (secret names, S3 keys); budget 3.5 KB.

### ADR-6 — Client protocol: pi RPC over the MicroVM proxy — Accepted
- REST + SSE for the common path, raw WebSocket RPC passthrough for attach (extension UI
  requests round-trip to the attached client). Tokens scoped to port 8080 only.

### ADR-7 — Single npm package: TS extension + shared core + CLI + prebuilt runner artifact — Accepted
- `pi install npm:pi-cloud-agents` installs everything; `dist/image/app.zip` and
  `dist/controller.zip` ship in the tarball; `bin: pi-cloud-agents` exposes the standalone CLI
  (`setup`, `verify`, `doctor`, `destroy`, `update`) that shares `core/` with the extension and
  needs no pi runtime. pi version pinned in the Dockerfile; drift detection in `doctor`/`update`.

### ADR-8 — Rich mirror-session attach UX — Accepted
- Mirror session = pi session file bound to the run; remote entries rendered with rich custom
  renderers (Markdown, syntax-highlighted diffs, bash output boxes, thinking collapsed, images,
  expand/collapse with pi's tool-expand key), live streaming widget, custom footer with remote
  model/tokens/cost/context, notifications on remote settle/errors. Input forwarding maps pi's
  own steer/follow-up semantics. Plus `/cloud open <run>`: import a snapshot of the remote session
  JSONL as a read-only local session for fully native browsing (`/tree`, search).

### ADR-9 — Local-first testing with a mock LLM; live tests env-gated with mandatory cleanup — Accepted

### ADR-10 — Setup and verification are product features, shared by TUI and CLI — Accepted
- Owner: "ship an easy script people can use to set up the entire AWS backend, with
  verification checks that it's all working, enabled and ready to be used from the TUI."
- Decision: `core/setup` (idempotent, resumable, dry-run) and `core/verify` (static checks +
  a live **smoke run** with the mock LLM: launch → ready → prompt → tool call → idle → suspend →
  resume → terminate → cleanup, each step ✓/✗ with remediation) are driven by both
  `/cloud setup|verify` (pi UI) and `npx pi-cloud-agents setup|verify` (terminal prompts).
  `setup --verify` runs both. When at least one provider is synced, verify **also sends one real
  one-line prompt with the user's default model** to prove auth end to end (owner decision R4;
  ≈ $0.01; `--no-model` skips). Reports are written to `~/.pi/agent/pi-cloud-agents/verify-<ts>.json`.

### ADR-11 — All defaults configurable from a TUI settings screen — Accepted
- `/cloud config` (SettingsList) edits region/profile (post-setup change = guided migration),
  memory baseline (image property → triggers `/cloud update`), max duration, idle policy,
  concurrency, retention, keepalive, trust, auto-push, egress connector, synced providers.
  Per-repo overrides live in `.pi/cloud-agents.json`.

## B. Assumptions (verify early)

| # | Assumption | Verify in |
|---|---|---|
| A1 | Owner's AWS account has Lambda MicroVMs available in us-east-1 with default quota (400 GB+) | T0.2 |
| A2 | Node 22 (≥22.19) installs on the al2023-minimal ARM64 base and pi runs headless there | T0.5 |
| A3 | Any process in the guest can obtain execution-role credentials | **Verified by docs**: IMDSv2 at `169.254.169.254/latest/meta-data/iam/security-credentials/execution_role` |
| A4 | Hooks arrive on port 9000; `/run` must return ≤60 s; heavy work may continue after 200 | **Verified (T0.3)**: Hooks server on port 9000 receives `/run` hook with 3 KB JSON payload and answers 200 immediately while logging and persisting state. See [docs/evidence/T0.3.md](docs/evidence/T0.3.md) |
| A5 | WebSocket and SSE work through the proxy for long-lived connections (with heartbeats); `HTTP_INGRESS` suffices vs `ALL_INGRESS` | **Verified (T0.3)**: WebSocket echo verified with subprotocol framing (`lambda-microvms`, `lambda-microvms.authentication.<token>`, `lambda-microvms.port.8080`); SSE heartbeat stream verified over HTTP; port 9000 returns HTTP 403 Forbidden with port 8080-scoped token. See [docs/evidence/T0.3.md](docs/evidence/T0.3.md) |
| A6 | The guest can suspend itself | **Refuted by docs** ("No self-suspend from inside the MicroVM") → ADR-4 amended. Whether a guest can reach its own public endpoint (optional optimization) remains for T0.4 |
| A7 | Image build ≈ 2–3 min; ~7 GB build disk → keep the image lean; resume ≈ 1 s per 500 MB of memory snapshot accessed | T0.5 (measure) |
| A8 | `AWS::Lambda::MicrovmImage` supports hooks, env vars, memory baseline, tags | **Verified by CFN reference**; all properties required; async build → poll after stack completes (G3 confirms stabilization behavior) |
| A11 | `lambda:PassNetworkConnector` is required on every `RunMicrovm` even with default connectors | **Verified by docs**; included in OperatorPolicy and controller role |
| A12 | Lambda MicroVMs is GA (June 2026, 5 regions; 10 as of Aug 2026) with no account enablement step; new accounts have reduced quotas | Verified by AWS announcements + quotas page; T0.2 checks quotas |
| A9 | A copied pi credential works on a second machine; OAuth refresh does not invalidate the original (per provider) | **Verified with nuances (T0.6)**: API keys, GitHub Copilot, and OpenRouter are fully portable with zero refresh conflict. Rotating OAuth providers (Anthropic Claude, OpenAI Codex, xAI, Kimi Code, Radius) invalidate local refresh tokens upon remote refresh, confirming ADR-5 opt-in notice policy and T5.9 OAuth token broker requirement for seamless multi-instance OAuth. See [docs/evidence/T0.6.md](docs/evidence/T0.6.md) |
| A10 | Every provider's auth entry fits a Secrets Manager value (64 KB) — expected trivially true; record sizes | **Verified (T0.6)**: API key entries are ~50–250 B; OAuth entries are ~300–2,000 B; full auth.json files are ~1–10 KB — all well within the 64 KB (65,536 B) AWS Secrets Manager limit. See [docs/evidence/T0.6.md](docs/evidence/T0.6.md) |

## C. Owner decisions (2026-09-06) and remaining questions

| # | Question | Decision |
|---|---|---|
| Q1 | Runtime mode | **Agent loop in the VM; local pi mirrors it; reopening pi shows the active cloud session** (ADR-1, ADR-8) |
| Q2 | LLM providers | **Everything pi supports, by reusing pi's own credential/model system** (ADR-5) |
| Q3 | Git hosting | **GitHub, PAT for MVP; OAuth (device flow) / GitHub App later** (T5.2) |
| Q4 | Tenancy | **Team share eventually; one stack per user for MVP, team-ready layout** (ADR-2, T6.3) |
| Q5 | Region/practices | **Best practice, default us-east-1**, configurable |
| Q6 | Budget defaults | **Configurable from the TUI** (`/cloud config`, ADR-11); shipped defaults: 4 h max, 15 min idle → suspend, 2 h suspended → terminate, 3 concurrent, 4 GB/2 vCPU, 30-day archives |
| Q7 | Attach UX | **Full rich experience** (ADR-8) |
| Q8 | Trust repo `.pi/` in VM | **Yes** (`--approve`, configurable) |
| Q9 | Name/license | **`pi-cloud-agents`, MIT** |
| Q10 | Test account / setup | **No test account yet. Ship an easy, verifiable setup script + TUI verification** (ADR-10). Spikes run in the owner's account under `pi-cloud-agents-test*` with strict cleanup and a kill-switch |
| Q11 | Start implementation | **Not yet — plan must be solid first** |

Follow-up questions, answered 2026-09-06:

| # | Question | Decision |
|---|---|---|
| R1 | Which providers to sync to the VM | **All providers currently configured on the user's machine** (deselectable in `/cloud config`) |
| R2 | OAuth subscription providers in the VM | **Opt-in per provider with a ToS notice** (owner: "yes" to the recommended default; gated on spike T0.6) |
| R3 | GitHub org/repo and npm publisher | **Deferred** — decide before T5.8 (release) |
| R4 | Real model prompt in `/cloud verify` | **Yes** — on by default when a provider is synced; `--no-model` to skip |
| R5 | Secret store | **Best practice: AWS Secrets Manager** for credentials, optional customer-managed KMS key; SSM only for non-secret values |

No open questions remain. Phase 0 starts on the owner's go.

## E. Research verification log

| Date | What was checked | Outcome |
|---|---|---|
| 2026-09-06 | AWS API references (`RunMicrovm`, `CreateMicrovmImage`, `CreateMicrovmAuthToken`), CloudFormation `AWS::Lambda::MicrovmImage`, AWS agent-skill for MicroVMs (SKILL + IAM/security, networking, snapshots references), GA announcement, CloudFormation quick-create docs, Secrets Manager pricing | ADR-4 amended (controller-driven; self-suspend impossible); A3 verified (IMDSv2); A6 refuted; A8 verified with "all properties required"; A11/A12 added; `PassNetworkConnector`, confused-deputy trust conditions, `HTTP_INGRESS` default, shell over `wss://<endpoint>/shell` port 8022, image single-size, image-version storage cost, outbound connections killed on run/resume, token TTL ≤ 60 min, quick-create requires an S3-hosted template — all propagated to 01/04/05/AGENTS.md |

## D. Rejected alternatives (summary)

- Cursor-style external worker (local brain, VM hands) as the primary mode — laptop must stay open.
- Our own provider/auth abstraction in the VM — contradicts "use what exists in pi"; pi's
  `ModelRuntime` already resolves keys, OAuth, Bedrock, custom providers.
- DynamoDB run registry — S3 manifests suffice for single-tenant; team mode can add an index later.
- Secrets or per-run env in the payload/image — size limits, exposure, rebuild cost.
- Docker-built controller image (Cursor template) — requires Docker locally; not needed.
- Overlay-only attach viewer — no native scrolling/persistence; rejected for the rich UX.
