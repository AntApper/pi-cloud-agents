# 01 — Architecture

## 1. Product scope

### What we are building

`pi-cloud-agents`: a pi package that adds **cloud agents** to pi. A cloud agent is an autonomous
pi session that runs in an isolated cloud sandbox (an AWS Lambda MicroVM in the user's AWS
account), works on a git repository, and can push branches / open pull requests. The user
launches, watches, steers, and stops cloud agents from their local pi TUI (and the local LLM can
delegate to them via a tool).

Feature parity target with Cursor Cloud Agents (MVP column: ✓ = in MVP):

| Cursor capability | pi-cloud-agents equivalent | MVP |
|---|---|---|
| Start an agent on a repo with a prompt | `/cloud new` (repo/branch/model/prompt) | ✓ |
| Isolated VM per agent | one Firecracker MicroVM per run, terminated at end | ✓ |
| Follow-ups, steering | `/cloud attach` mirror session; steer/follow-up mapping | ✓ |
| Hibernate idle agents, resume on follow-up | MicroVM suspend/auto-resume (idle policy) | ✓ |
| Push branch / open PR | agent uses `gh`/git; `/cloud pr` runner-side helper | ✓ |
| List / status / logs | `/cloud list`, `/cloud status`, `/cloud logs` | ✓ |
| Secrets (LLM keys, repo token) | user's **own pi credentials** synced to AWS Secrets Manager in their account (all configured providers; OAuth opt-in); Bedrock via IAM role = zero LLM secrets | ✓ |
| Any model/provider | everything the local pi supports (pi's `ModelRuntime` runs in the VM with the synced config) | ✓ |
| Reopen laptop → see the running agent | mirror session auto-reattaches, replays from cursor, resumes a suspended VM | ✓ |
| Guided setup + verification | `/cloud setup`, `/cloud verify`, `npx pi-cloud-agents setup --verify` | ✓ |
| Configurable defaults | `/cloud config` settings screen | ✓ |
| Self-hosted machines (your infra) | everything runs in **your** AWS account | ✓ |
| Environment install script | `.pi/cloud-agents.json` `install` step at launch | ✓ |
| Environment Builds (pre-baked snapshots per repo) | `/cloud build` per-repo image versions | later |
| Secret redaction | in-VM pi extension redacts secret values from tool output | Phase 5 |
| Cursor-hosted agent loop | **not applicable** — the agent loop runs *inside* the MicroVM | — |
| Web / mobile / Slack / GitHub triggers | static viewer + webhook launcher | later |

### Non-goals (MVP)

- A hosted multi-tenant SaaS. Every user deploys into their own AWS account.
- GPU / macOS workers. Lambda MicroVMs are Linux ARM64 only.
- Re-implementing provider auth. The VM runs pi with the user's synced pi config (ADR-5).
  OAuth subscription providers are supported only after spike T0.6 confirms credential
  portability, behind an explicit opt-in with a ToS notice.
- Agents running longer than 8 hours in one VM (AWS hard limit) — handled by *continuation*
  (new VM restored from the archived session + work branch), planned in Phase 5.

## 2. Key architectural difference from Cursor Self-Hosted Machines

Cursor: agent loop + inference in Cursor's cloud; worker on your machine executes tool calls
over an outbound connection. We have no hosted control plane, so:

- **The agent loop (`pi --mode rpc`) runs inside the MicroVM.** Tool calls are local to the
  VM (fast, no relay). The VM talks to the LLM provider directly (or to Bedrock via IAM).
- **The local extension is a client**, not the brain. Closing the laptop does not stop the run.
- **State lives in the user's account** (S3 manifests + mirrored session JSONL), so any
  machine with the same AWS creds can list/attach/continue runs.

## 3. Components

```
┌──────────────── user's laptop ─────────────────┐      ┌──────────────── user's AWS account ───────────────────┐
│ pi TUI                                         │      │  CloudFormation: pi-cloud-agents-core / -image        │
│  └─ pi-cloud-agents extension                  │      │   • S3 bucket   runs/<runId>/{manifest.json,          │
│      • /cloud setup|new|list|attach|stop|...   │ AWS  │                 session.jsonl, archive.tar.zst}       │
│      • cloud_agent tool (LLM delegation)       │ SDK  │   • Secrets Manager  pi-cloud-agents/<stack>/...      │
│      • deployer (CFN, S3, Secrets, MicroVMs) ───┼──────┼─▶ • IAM: BuildRole, ExecutionRole, OperatorPolicy     │
│      • run client (token, HTTP, SSE, WS) ──────┼──────┼─▶ • MicroVM image  pi-cloud-agents-runner (ARM64)     │
│      • mirror session renderer                 │HTTPS │   • Controller Lambda (EventBridge rate 1 min)        │
└────────────────────────────────────────────────┘      │                                                       │
                                                        │  per run: MicroVM  ┌──────────────────────────────┐   │
                                                        │   endpoint ───────▶│ runner (Node)                │   │
                                                        │   :9000 hooks      │  hooks | API :8080 | sync    │   │
                                                        │                    │  git workspace  /work/repo   │   │
                                                        │                    │  pi --mode rpc  (agent loop) │   │
                                                        │                    └──────────────┬───────────────┘   │
                                                        └───────────────────────────────────┼───────────────────┘
                                                                     LLM provider / Bedrock ◀┘  GitHub ◀┘
```

### 3.0 Shared core (`core/`) and CLI (`cli/`)

All AWS operations, the setup engine, the verification engine, the run client, and the pi
config-bundle builder live in `core/` with **no dependency on the pi runtime**. Two front ends
use it: the pi extension (`ctx.ui` prompts, TUI components) and a standalone CLI
(`npx pi-cloud-agents setup|verify|doctor|update|destroy`, terminal prompts). A `Prompter`
interface abstracts select/confirm/input/progress so the same step machines run in both.

### 3.1 Local extension (`extension/`)

- Registers `/cloud` (sub-commands with argument completion), the `cloud_agent` tool, a footer
  status (`cloud 2 running`) in every session, entry renderers + a custom footer for mirror
  sessions, and an `input` handler used only inside mirror sessions.
- AWS access through the default credential chain (`@aws-sdk/credential-providers`
  `fromNodeProviderChain`, optional `profile`) + region from config. Needs the permissions in
  `OperatorPolicy` (stack output) — the setup wizard prints what is missing on AccessDenied.
- Config file `~/.pi/agent/pi-cloud-agents.json` (respects `PI_CODING_AGENT_DIR`), mode 0600,
  **never contains secrets** (secrets live in Secrets Manager; AWS creds come from the AWS chain).
- Per-repo config `.pi/cloud-agents.json` (Cursor `environment.json` analogue):
  `install` (shell, run after clone, time-boxed), `start` (background processes), `env`
  (non-secret vars), `secrets` (allow-listed Secrets Manager secret names to expose), `model` default.
- **pi config bundle** (ADR-5): built from the local pi install — provider credentials for the
  providers a run needs (API keys resolved via `ctx.modelRegistry.getProviderAuth()`, OAuth
  entries copied from `auth.json` when opted in), `models.json`, a settings subset, global
  `AGENTS.md`, and (Phase 5) global skills/prompts. By default **all providers configured
  locally** are synced (OAuth ones only when opted in). Secrets → Secrets Manager
  `pi-cloud-agents/<stack>/pi-auth/<provider>`; the rest → S3 `config/<owner>/bundle.tar`.
  `/cloud sync` refreshes it; `/cloud new` checks the selected model's provider is synced.

### 3.2 Runner (`runner/`, bundled into the image)

Single Node 22 process (`node /opt/pi-cloud/runner.js`), started by the image `ENTRYPOINT` so
it is *inside the snapshot* (fast start). Responsibilities:

1. **Lifecycle hooks** on `0.0.0.0:9000`, paths `/aws/lambda-microvms/runtime/v1/{ready,validate,run,resume,suspend,terminate}`:
   - `ready` → 200 once the process is initialized (503 before). `validate` → self-check (`pi --version`, git present) → 200.
   - `run` → parse `runHookPayload` (LaunchPayload v1), **return 200 within ~1 s**, then continue provisioning asynchronously (fetch the pi config bundle + SSM auth entries via the execution role and assemble `~/.pi/agent/` in the VM, clone, install, start pi).
   - `resume` → refresh tokens/connections, mark `running`. `suspend`/`terminate` → flush session + manifest to S3, commit WIP, return 200 within the configured timeout (≤60 s). Idempotent.
2. **Agent loop**: spawns `pi --mode rpc --session-dir /work/.pi-sessions [--approve] --provider … --model …` in the repo directory with `PI_CODING_AGENT_DIR` pointing at the assembled config; pi's own `ModelRuntime` resolves credentials exactly as on the user's machine (API keys, OAuth, Bedrock via ambient AWS creds, custom providers from `models.json`). Bridges JSONL RPC (LF framing only — see pi `docs/rpc.md`).
3. **Run API** on `:8080` (the only port client tokens are scoped to):
   - `GET /v1/status` — run state, agent state, cursor, git summary, usage/cost, warnings (e.g. `T-15min to max duration`).
   - `POST /v1/prompt` `{message, mode: "prompt"|"steer"|"followUp"}`, `POST /v1/abort`, `POST /v1/pr`, `POST /v1/checkpoint`, `POST /v1/shutdown`.
   - `GET /v1/entries?since=<entryId>` (durable cursor, mirrors pi RPC `get_entries`), `GET /v1/events` (SSE stream of pi events + runner state changes, replay from cursor, 15 s heartbeats).
   - `GET /v1/rpc` (WebSocket) — raw pi RPC passthrough for advanced clients; fan-out events to all clients; `extension_ui_request`s routed to the attached client.
4. **Persistence** (`StorageSink`): `runs/<runId>/manifest.json` on every state transition; `session.jsonl` mirrored (debounced while streaming, flushed on `agent_settled`, suspend, terminate); optional `archive.tar.zst` of the workspace for continuation.
5. **Lifecycle reporting**: idle detection (agent settled + no attached client for N s) exposed in `/v1/status` for the controller to act on, safe finalize (auto-commit to `pi-cloud/<runId>` after each settled turn; push if enabled), max-duration awareness (checkpoint at T-15 min).
6. **Security helpers**: secret values are registered with the logger for redaction; git credentials via `GIT_ASKPASS` helper (token never written to `.git/config`).

### 3.3 Infra (`infra/`)

Two CloudFormation stacks (deployed by the extension, idempotent, change-set based):

- **`pi-cloud-agents-core`**: S3 bucket (private, SSE, lifecycle expiry for `runs/` after N days),
  CloudWatch log groups with retention, `BuildRole` (s3:GetObject on artifact key + logs),
  `ExecutionRole` (least privilege, see §5), `OperatorPolicy` (managed policy describing what the
  local user needs — attachable to their IAM user/role), optional customer-managed KMS key
  (`KmsKeyArn` parameter; default AWS-managed `aws/secretsmanager`), Secrets Manager name prefix reserved.
- **`pi-cloud-agents-image`**: `AWS::Lambda::MicrovmImage` (ARM64, hooks on 9000, memory baseline,
  env vars for non-secret static config, tags), the controller Lambda + EventBridge rule. Split from
  core because the runner zip must be uploaded to the bucket *before* the image builds, and image
  updates should not touch the bucket/roles.

If the CFN image resource turns out to lack a needed property, the fallback is SDK-driven
`CreateMicrovmImage`/`UpdateMicrovmImage` with identical inputs (decided in T3.1b).

**Controller Lambda** (keepalive + idle policy + janitor; runs every minute, Node 22 arm64):
lists MicroVMs for the image; for each RUNNING VM mints a token and `GET /v1/status` — that
inbound request is the platform's activity signal, so a working agent is never idle-suspended;
from the status it applies the run's policy: agent settled and no attached client for
`idleGraceSec` → `SuspendMicrovm`; `finished|failed` for >10 min → `TerminateMicrovm`; no manifest
after 20 min or age > `maxDuration + 10 min` → terminate; suspended VMs are left to the platform's
`suspendedDurationSeconds`; force-deletes run-scoped Secrets Manager secrets of terminated runs;
writes `controller/last-run.json` (shown as "controller ran 40 s ago" in dashboard/verify).
AWS documents that a VM cannot suspend itself, so this external controller is the only correct
place for suspend decisions (ADR-4).

## 4. Lifecycle of a run

```
/cloud new ──▶ write manifest{launching} ──▶ RunMicrovm(image ARN + version, execRole, HTTP_INGRESS(+SHELL_INGRESS)
               +INTERNET_EGRESS, maxDuration, safety-net idlePolicy, logging, runHookPayload) ──▶ RUNNING (~2-4 s)
           ──▶ POST /run(payload) ──▶ runner: 200; async: secrets → clone → install → start pi
           ──▶ client mints token (port 8080, 30 min) → polls /v1/status until ready
           ──▶ POST /v1/prompt(initial task) ──▶ agent works; runner mirrors session + manifest
           ──▶ agent settles → auto-commit WIP → (client attached? stream) : controller sees idle ≥ grace →
               SuspendMicrovm ──▶ SUSPENDED (snapshot storage only)
           ──▶ follow-up: client request auto-resumes VM (+1-2 s) ──▶ /resume hook ──▶ continue
           ──▶ /cloud stop | idle-terminate | max duration ──▶ /terminate hook: flush, push ──▶ TERMINATED
```

Manifest `status` enum: `launching → provisioning → ready → running ↔ idle ↔ suspended → finished | failed | terminated`.

### Keepalive and idle handling (ADR-4, controller-driven)

Idle is measured by *inbound* traffic through the proxy. While the agent works autonomously with
no client attached, a plain idle policy would suspend a working agent — and AWS documents that a
VM **cannot suspend itself**. Therefore:

- The **controller Lambda polls `/v1/status` every minute** on every RUNNING VM (keepalive) and
  decides suspend/terminate from the runner-reported state (`agent.state`, `attachedClients`,
  `idleSince`, `status`) and the run's policy in the manifest.
- The **attached client** also polls `/v1/status` every 60 s (RTT metric; extra traffic).
- Each VM carries a platform **safety-net idle policy**: `maxIdleDurationSeconds` 1200,
  `suspendedDurationSeconds` = configured terminate-after-suspended, `autoResumeEnabled: true`
  (so the client's next request auto-resumes a suspended VM), plus `maximumDurationInSeconds`.
- The runner has **no `lambda:*` permissions** and no self-suspend logic; it only reports state
  and flushes on `/suspend` and `/terminate`. Because all outbound connections are killed on
  run/resume, the runner retries in-flight uploads after `/resume` (AWS SDKs recover on their own).
- Optional optimization tested in T0.4: the runner heartbeating its own public endpoint while
  streaming would allow a 5-minute controller cadence; the 1-minute controller is the default.

## 5. Security model

### Trust boundaries

- The **MicroVM guest is untrusted**: it executes LLM-generated commands. Everything reachable
  from the guest is exposed to a prompt-injected or malfunctioning agent: execution-role
  credentials (any process in the guest can obtain them), secrets materialized in env, the git
  token, the LLM key, and network egress.
- The **local extension is trusted** (runs with the user's AWS credentials).
- The **proxy endpoint** is the only inbound path; every request needs a JWE token minted with
  IAM (`CreateMicrovmAuthToken`), scoped to port 8080, 30-minute expiry, refreshed by the client.

### Controls

| Area | Control |
|---|---|
| Isolation | one Firecracker VM per run; terminated at end; no shared state; never reuse a VM across repos |
| Execution role | least privilege: `s3:Get/Put/DeleteObject` on `runs/*` and `s3:GetObject` on `config/*` of the stack bucket, `secretsmanager:GetSecretValue` on `pi-cloud-agents/<stack>/*` (+ `kms:Decrypt` on the key), `logs:*` on its log groups, optional `bedrock:InvokeModel*`. **No `lambda:*`** (controller-driven design). Credentials are exposed to every guest process via IMDSv2 (`169.254.169.254/…/execution_role`) — this is why the role stays minimal |
| Trust policies | build and execution roles trust `lambda.amazonaws.com` with confused-deputy conditions `aws:SourceAccount` = account and `aws:SourceArn` like `arn:aws:lambda:<region>:<account>:microvm-image:*` |
| Operator / controller | need `lambda:PassNetworkConnector` on the AWS-managed connector ARNs (and any custom VPC connector) for every `RunMicrovm`, even with default connectors |
| Secrets | AWS Secrets Manager (KMS-encrypted, versioned, CloudTrail-audited); never baked into the image; never in the run-hook payload (only secret *names*); written only into the VM's `~/.pi/agent/auth.json` (mode 0600) and process env; redacted from runner logs; Phase 5 adds in-VM redaction of tool output. "Sync all providers" means every synced credential is exposed to agent code in every VM — documented, deselectable in `/cloud config` |
| Repo credentials | fine-grained PAT scoped to target repos (MVP) → GitHub OAuth device flow / GitHub App installation tokens minted per run, 1h expiry, stored under `runs/<runId>/` and deleted by the janitor (Phase 5) |
| LLM credentials | the user's own pi credentials, **only for providers the run needs** (least exposure); **Bedrock via execution role** needs no secret; OAuth providers opt-in after T0.6 |
| Owner identity | every manifest and S3 object carries `owner` = caller ARN; team mode later scopes IAM by owner |
| Client auth | proxy JWE tokens only; hooks port never in client tokens; optional per-run shared secret header (hardening) |
| Project trust | the cloud agent runs the repo's `.pi/` config with `--approve` **only if** `trustProjectConfig` (default true: it's the user's own repo inside a sandbox) |
| Network | default `INTERNET_EGRESS`; optional VPC egress connector ARN for private resources; outbound UDP is blocked by the platform (DNS via the platform stub) |
| Cost | `maximumDurationInSeconds` always set (default 4h, cap 8h); controller suspends after 15 min idle (default) and terminates finished/orphaned runs; platform safety-net idle policy; local concurrency cap; `/cloud list` shows elapsed + estimated cost; old image versions deleted on `/cloud update` (versions cost storage even when unused) |
| Supply chain | pi version pinned in the image; runner bundle SHA in image manifest; `npm audit --omit=dev` + gitleaks in CI |
| Data at rest | S3 SSE, private bucket, lifecycle expiry; archives contain code + transcripts → documented |

### Known residual risks (documented for users)

1. Execution-role creds are reachable by agent code through IMDSv2 → keep the role minimal;
   hardening options later: per-run scoped credentials (STS session policy), or running the pi
   process as a separate Linux user with an IMDS firewall rule (needs `AdditionalOsCapabilities: ALL`).
2. Secrets in env are visible to `bash` → redaction (Phase 5) mitigates leakage into transcripts,
   not exfiltration by a malicious agent with internet egress. Users needing egress control use a
   VPC egress connector with restrictive security groups.

## 6. Cost model (us-east-1, ARM, from AWS pricing examples)

| Item | Rate | Notes |
|---|---|---|
| vCPU | $0.0000276944 / vCPU-second | baseline billed while RUNNING; bursts to 4× billed on use |
| Memory | $0.0000036667 / GB-second | |
| **2 GB / 1 vCPU baseline** | ≈ **$0.126 / hour** | default for light repos |
| **4 GB / 2 vCPU baseline** | ≈ **$0.252 / hour** | recommended default (builds/tests) |
| Suspended VM | $0.08 / GB-month snapshot storage | ≈ negligible |
| Suspend / resume | $0.0038 / GB write, $0.00155 / GB read | per cycle |
| Image storage | $0.08 / GB-month (1-week minimum) | |
| Controller Lambda (1-min schedule) + S3 + logs | ≈ 43k invocations/month, within the Lambda free tier; cents otherwise | |
| Secrets Manager | $0.40 / secret / month (+ $0.05 per 10k API calls) | typically 3–10 secrets → $1–4 / month |
| Customer-managed KMS key (optional) | $1 / month | default uses the AWS-managed key |
| LLM tokens | provider pricing | usually the dominant cost |

A typical 45-minute agent run on 4 GB ≈ $0.19 compute + LLM tokens.

## 7. Repository layout (single publishable npm package)

```
pi-cloud-agents/
├── package.json              # "pi": { "extensions": ["./extension/index.ts"] }, peerDeps on pi packages
├── core/                     # pi-runtime-free engine shared by extension and CLI
│   ├── aws/                  # clients factory, stack deployer, image manager, secrets, microvm ops, logs
│   ├── setup/                # setup step machine (idempotent, resumable, dry-run)
│   ├── verify/               # static checks + smoke run + report
│   ├── client/               # run client: tokens, HTTP, SSE, WS, reconnect
│   ├── pi-config/            # config bundle builder (auth entries, models.json, settings, AGENTS.md)
│   ├── prompter.ts           # UI abstraction (select/confirm/input/progress)
│   └── config.ts             # local config load/save
├── extension/                # local pi extension (TypeScript, loaded by pi via jiti)
│   ├── index.ts              # registers /cloud, cloud_agent tool, renderers, status, footer
│   ├── commands/             # setup, verify, config, sync, new, list, attach, open, stop, logs, pr, update, destroy, doctor, shell
│   ├── ui/                   # wizard adapters, tables, rich renderers, mirror session, footer
│   └── prompter-pi.ts        # Prompter over ctx.ui
├── cli/                      # `pi-cloud-agents` bin: setup|verify|doctor|update|destroy (terminal prompter)
├── runner/                   # in-VM runtime (bundled with esbuild → dist/runner/index.js)
│   ├── main.ts, hooks.ts, api.ts, pi-process.ts, workspace.ts, secrets.ts, storage.ts,
│   ├── state.ts, lifecycle.ts, logger.ts
│   └── pi-extensions/redact.ts        # loaded by the in-VM pi (Phase 5)
├── shared/                   # protocol schemas (zod), manifest, config schemas, constants
├── image/Dockerfile          # FROM public.ecr.aws/lambda/microvms:al2023-minimal (ARM64)
├── infra/                    # core.yaml, image.yaml, controller/ (Lambda source), policies
├── scripts/                  # build-image-zip, dev harness, spikes, e2e
├── tests/                    # unit (vitest), integration (fake pi/runner), e2e (env-gated)
├── docs/                     # plan/, protocol.md, threat-model.md, evidence/
└── dist/                     # build output shipped in the npm tarball: image/app.zip, controller.zip
```

Toolchain: Node 22, TypeScript strict, vitest, biome, esbuild, `@aws-sdk/*` v3
(`client-lambda-microvms`, `client-cloudformation`, `client-s3`, `client-secrets-manager`, `client-sts`,
`client-cloudwatch-logs`, `credential-providers`), `zod`, `ws`, `aws-sdk-client-mock` (tests).

## 8. Runner API ↔ pi RPC mapping

| Runner API | pi RPC (inside VM) |
|---|---|
| `POST /v1/prompt {mode:"prompt"}` | `{"type":"prompt","message"}` (error if streaming → client must choose steer/followUp) |
| `POST /v1/prompt {mode:"steer"}` | `{"type":"steer"}` |
| `POST /v1/prompt {mode:"followUp"}` | `{"type":"follow_up"}` |
| `POST /v1/abort` | `clear_queue` then `abort` |
| `GET /v1/entries?since` | `get_entries {since}` |
| `GET /v1/status` | `get_state` + `get_session_stats` + runner state |
| `GET /v1/events` (SSE) | all RPC events + `runner_state` events |
| `GET /v1/rpc` (WS) | raw passthrough incl. `extension_ui_request/response` |

## 9. Local attach UX ("mirror session") — rich, durable, auto-reconnecting

`/cloud attach <run>` creates (or switches to) a local pi session named `cloud: <run>`, stores the
binding as a custom entry, replays remote entries since the last cursor as **custom entries**
(TUI-only, never sent to the local LLM), streams live text into a widget, and forwards editor
input to the remote run: idle → `prompt`; while remote is streaming, pi's own steer/follow-up
distinction (`input.streamingBehavior`) maps to `steer`/`followUp`. `/cloud detach` returns to
normal. This reuses pi's transcript scrolling and persistence instead of a bespoke viewer.

Rich rendering: assistant text as Markdown (pi theme), thinking collapsed (toggle with pi's
key), tool calls rendered like pi's own rows (bash output box, `edit` diffs syntax-highlighted
from `details.diff`, `read`/`write`/`grep` summaries, images), expand/collapse honoring pi's
tool-expand state, remote errors/retries/compaction shown, a custom footer with the remote
model, thinking level, tokens, cost, context %, VM state (running/idle/suspended) and elapsed
time, and notifications when the remote agent settles or fails.

Durability ("close the laptop, open it, it's there"): the binding + cursor are persisted in the
mirror session file. On `session_start` (pi launch, `pi -c`, `/resume`) the extension detects a
bound session and **auto-reattaches**: refreshes the token, reads `/v1/status` (auto-resuming a
suspended VM), replays entries since the cursor, reopens SSE/WS. Sleep/network loss → reconnect
with backoff, never duplicating entries (idempotent by entry id). If the VM is gone
(terminated/8 h cap), the session shows the final state and offers `/cloud continue`.

Native viewer: `/cloud open <run>` downloads the remote session JSONL snapshot and imports it as
a read-only local session (pi's own renderers, `/tree`, search) for deep inspection.

## 10. Setup and verification flow (ADR-10)

```
setup  (TUI: /cloud setup | CLI: npx pi-cloud-agents setup [--verify] [--dry-run] [--profile P --region R])
  1 preflight   sts identity · region supports MicroVMs · quotas · operator permissions probe
  2 choices     profile/region · providers to sync (from local pi) · Bedrock role? · GitHub PAT · sizing/budget
  3 core stack  CloudFormation create/update (change sets, streamed events)
  4 artifact    upload dist/image/app.zip + dist/controller.zip (content-addressed keys)
  5 image stack MicrovmImage build (2–3 min, progress; base image version resolved) + controller schedule
  6 secrets     pi auth entries (all configured providers) → Secrets Manager · GitHub token → Secrets Manager · config bundle → S3
  7 config      write ~/.pi/agent/pi-cloud-agents.json (no secrets)
  8 verify      (see below)  → "ready: /cloud new"

verify (TUI: /cloud verify | CLI: npx pi-cloud-agents verify [--with-model])
  static  identity · stacks CREATE/UPDATE_COMPLETE · bucket private+encrypted · image ACTIVE and
          runner sha == package · secrets present for synced providers · controller scheduled and ran < 2 min ago ·
          operator has lambda:PassNetworkConnector
  smoke   RunMicrovm(mock-llm, maxDuration 900s) → RUNNING ≤ 30 s → /run → ready ≤ 3 min →
          prompt → bash tool call observed → idle → suspend → resume → status → terminate → S3 has
          manifest+session → cleanup verified.  Then one real 1-line prompt with the user's default
          model (default on when a provider is synced; `--no-model` skips) to prove auth end to end.
  report  table ✓/✗ + remediation per check; JSON report saved; exit code non-zero on failure
```

Every step is idempotent and resumable; re-running `setup` after a partial failure continues.
