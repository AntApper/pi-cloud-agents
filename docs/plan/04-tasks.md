# 04 — Task breakdown

Conventions: **Size** S ≤1 h · M 1–3 h · L 3–6 h (split if exceeded). **[AWS]** = touches a real
AWS account (rules in `03-agent-workflow.md §3`). **[parallel-ok]** = may start before the
preceding gate passes. Every card's *Validate* list is the gate to mark it `done`; the global
definition of done (`03-agent-workflow.md §2`) always applies too.

Repo-level commands (created in T0.1, used everywhere):

| Command | Meaning |
|---|---|
| `npm run check` | typecheck + lint + unit tests |
| `npm run test:unit` / `npm run test:integration` | vitest suites |
| `npm run build` | runner bundle + image zip + controller zip into `dist/` |
| `npm run e2e:local` | full local run with fake hooks + mock LLM (Gate G2) |
| `PI_CLOUD_E2E=1 npm run e2e:aws` | live AWS smoke (Gates G3/G4) |
| `npm run spike:<name>` | one-off spike scripts under `scripts/spike/` |

---

## Phase 0 — Foundations and de-risking spikes

### T0.1 — Repository scaffold and toolchain — S/M
- Depends on: —
- Do: `package.json` (name `pi-cloud-agents`, `"pi": {"extensions": ["./extension/index.ts"]}`,
  `keywords: ["pi-package"]`, peerDependencies `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
  `@earendil-works/pi-tui`, `typebox` as `"*"`; runtime deps in `dependencies`; `engines.node >=22.19`);
  `tsconfig.json` strict; vitest; biome; esbuild config; scripts table above (stubs allowed);
  `extension/index.ts` hello extension registering `/cloud` that notifies "pi-cloud-agents loaded";
  GitHub Actions CI (`node 22`, `npm ci`, `npm run check`); `.gitignore`, `LICENSE`, `.editorconfig`;
  keep `AGENTS.md`, `CLAUDE.md`, `docs/plan/JOURNAL.md` at their current paths and add the
  `ui-style` doc scan (docs + README + AGENTS.md) to `npm run check` early (full kit lint in T4.1b);
  add `docs/evidence/.gitkeep` and `docs/testing/`.
- Deliverables: repo skeleton, CI green, `AGENTS.md §5` commands table true.
- Validate:
  1. `npm run check` → exit 0 (with at least one placeholder test and the doc glyph scan).
  2. `pi --no-extensions -e ./extension/index.ts --mode rpc --no-session` then send
     `{"type":"get_commands"}` → response lists `cloud` with `source: "extension"`; exit.
  3. `npm pack --dry-run` → tarball includes `extension/`, `shared/`, `package.json`; excludes `tests/`.
- Done when: CI passes on the initial commit.

### T0.2 — Spike: AWS account readiness [AWS] — S
- Depends on: T0.1
- Do: `scripts/spike/aws-readiness.ts`: `sts:GetCallerIdentity`; `ListManagedMicrovmImages` in the
  target region (prove MicroVMs are enabled; capture base image ARN + versions);
  `ListMicrovmImages`/`ListMicrovms` (permissions probe); Service Quotas lookup for MicroVM memory
  (best effort); print a readiness table. Also the **kill-switch** `scripts/aws-cleanup.ts`
  (`npm run aws:cleanup -- --region <R>`): terminates every MicroVM whose image name starts with
  `pi-cloud-agents-test`, deletes test images/stacks/parameters on `--all`. Required before any
  other [AWS] task because there is no dedicated test account yet (owner decision Q10).
- Validate:
  1. `npm run spike:aws-readiness -- --region us-east-1` → prints account (masked), base image ARN, quota.
  2. `npm run aws:cleanup -- --region us-east-1 --dry-run` → lists nothing to clean (fresh account) and exits 0.
  3. Evidence records the regions available to this account and the base image ARN/version.
- Done when: the table shows READY for us-east-1, or a documented blocker.

### T0.3 — Spike: hello MicroVM end to end via SDK [AWS] — M
- Depends on: T0.2
- Do: `scripts/spike/hello-microvm.ts` with **no local Docker**: create temp bucket + build role
  (or reuse a `pi-cloud-agents-test-spike` mini stack), zip `Dockerfile` (`FROM public.ecr.aws/lambda/microvms:al2023-minimal`,
  install nodejs) + `server.js` (hooks on 9000: ready/validate/run/resume/suspend/terminate log +
  200; app on 8080: `GET /` echo of `/run` payload, `GET /ws` echo WebSocket, `GET /sse` heartbeat
  stream); `CreateMicrovmImage` with all hooks ENABLED and explicit timeouts; poll to CREATED;
  `RunMicrovm` (ALL_INGRESS + INTERNET_EGRESS, `maximumDurationInSeconds 1800`, idle policy
  900/600/autoResume true, `runHookPayload` 3 KB JSON, CloudWatch logging); `CreateMicrovmAuthToken`
  (port 8080 only); HTTPS GET; WebSocket echo; SSE for 60 s; `SuspendMicrovm` → `ResumeMicrovm`
  → GET again; `TerminateMicrovm`; measure every step; clean up (image, bucket, role).
- Validate:
  1. `PI_CLOUD_E2E=1 npm run spike:hello-microvm -- --region <R>` → exit 0 and a timing table
     (image build, run→RUNNING, first 200, suspend, resume, terminate).
  2. Payload echoed back intact (3 KB); WebSocket echo ≥ 10 frames; SSE received ≥ 3 heartbeats.
  3. A token scoped to port 8080 gets **403** on `X-aws-proxy-port: 9000`.
  4. Cleanup verification block passes.
- Done when: all four pass; timings recorded in `05-references.md §Measured`.

### T0.4 — Spike: guest capabilities and controller-driven idle handling [AWS] — M
- Depends on: T0.3
- Do: extend the hello image with a `/diag` endpoint (and run with `SHELL_INGRESS` too) to answer:
  (a) confirm execution-role creds via IMDSv2 (`curl 169.254.169.254/latest/meta-data/iam/security-credentials/execution_role`
  with an IMDSv2 token) and that the AWS SDK default chain works from an unprivileged child process;
  (b) outbound HTTPS to `api.anthropic.com`, `api.openai.com`, `github.com`, `registry.npmjs.org`,
  `bedrock-runtime.<R>.amazonaws.com`; (c) run-hook payload size: 3.5 KB ok? 4.5 KB? 8 KB? (the API
  lists both 4096 chars and 16 KB); (d) hooks arrive on 9000 even if configured otherwise;
  (e) `/run` returning 200 then continuing background work is fine; (f) **external keepalive**:
  with `maxIdleDurationSeconds` 120, an outside `GET /` every 60 s keeps the VM RUNNING for 6 min,
  and stopping the pings leads to SUSPENDED; a new request auto-resumes (`autoResumeEnabled`);
  (g) **external suspend**: `SuspendMicrovm` from outside while the app is idle → `/suspend` hook
  fired → SUSPENDED → `ResumeMicrovm` → `/resume` fired; measure both; (h) after resume: clock jump,
  timers, and that an outbound HTTPS keep-alive connection opened before suspend is dead while a
  fresh request works (AWS: outbound connections are killed on run/resume); (i) disk free, CPU arch,
  `/dev/ptmx`, memory snapshot size from `get-microvm-image-build`; (j) shell: `create-microvm-shell-auth-token`
  + WebSocket to `wss://<endpoint>/shell` with subprotocols `lambda-microvms`,
  `lambda-microvms.authentication.<token>`, `lambda-microvms.port.8022`; (k) **optional
  optimization**: guest GETs its own public endpoint with a token minted by a *temporary* test role
  permission — does that count as activity? (only informs controller cadence; not required).
- Validate:
  1. Evidence contains the checklist (a)–(k) each PASS/FAIL/N-A with observed values and timings.
  2. `02-decisions.md` A3–A7 marked; ADR-4 controller cadence confirmed (1 min) or relaxed if (k) passes.
  3. Cleanup verification block passes.
- Done when: recorded and merged.

### T0.5 — Spike: pi headless on ARM64 AL2023 + mock LLM [AWS] — M
- Depends on: T0.3
- Do: `image/Dockerfile` v0: install Node 22 (`dnf install nodejs22` or official arm64 tarball),
  git, tar, gzip, which, findutils, procps, `npm i -g @earendil-works/pi-coding-agent@<pinned>`;
  `runner/pi-extensions/mock-llm.ts`: a pi extension registering provider `mock-llm` with
  `streamSimple` that plays a script (first turn: `bash` tool call `echo hello > hello.txt`;
  second turn: final text) — zero token cost; hooks server runs `pi --mode rpc --no-session
  --provider mock-llm --model scripted -e /opt/pi-cloud/pi-extensions/mock-llm.ts` on `/validate`
  and reports the transcript via `/diag`. Build image; run; check via endpoint; terminate.
- Validate:
  1. `pi --version` inside the guest equals the pinned version; `node -v` ≥ 22.19; `uname -m` = aarch64.
  2. Mock run transcript shows `tool_execution_end` for `bash` and a final assistant message.
  3. Image build time and size recorded; build succeeded within the ~7 GB build disk.
  4. Cleanup verification block passes.
- Done when: the Dockerfile v0 and mock-llm extension are committed.

### T0.6 — Spike: pi credential portability (API keys and OAuth) — M
- Depends on: T0.1 [parallel-ok]
- Do (no AWS needed): create a second pi config dir (`PI_CODING_AGENT_DIR=/tmp/pi-b`); for each
  provider with credentials on the owner's machine: (a) API-key providers — resolve via a tiny
  extension calling `ctx.modelRegistry.getProviderAuth(id)` and write an `auth.json` entry into
  dir B; run `pi -p "reply OK"` from B; (b) OAuth providers (Anthropic, OpenAI Codex, Copilot) —
  copy the raw `auth.json` entry to B; run a prompt from B; wait until B refreshes the token
  (or force by editing `expires`); then run a prompt from A. Record per provider: works in B?
  A still works after B refreshed? Entry size (bytes)? Also confirm the `auth.json` schema used.
- Validate:
  1. Evidence table per provider: portable (Y/N), refresh conflict (Y/N/N-A), entry size.
  2. ADR-5 amended: providers safe to sync by default; OAuth opt-in list; whether T5.9 (token broker) is required.
  3. A10 marked (entry sizes recorded; all ≤ 64 KB Secrets Manager limit).
- Done when: recorded and reviewed. Note: never commit tokens; evidence shows sizes only.

### G0 — Gate: spikes complete, decisions confirmed — S
- Depends on: T0.2–T0.6
- Checklist: all spike evidence files present; `02-decisions.md` assumptions A1–A10 marked
  Verified/Refuted with links; `05-references.md §Measured` filled; `npm run aws:cleanup`
  verified to leave nothing behind; `AGENTS.md §7–§8` updated with any gotcha the spikes
  found; `JOURNAL.md` current.
- Passed when: owner or reviewer marks `G0 passed` in STATUS.md.

---

## Phase 1 — Contracts (shared)

### T1.1 — Protocol and manifest schemas — M
- Depends on: G0
- Do: `shared/protocol.ts` (zod): `LaunchPayload` v1 `{v, runId, owner, stack:{name,region,bucket,prefix},
  repo:{url,ref,workBranch,depth}, model:{provider,id,thinking?}, piConfig:{bundleKey, authParams:string[],
  bedrockRole:boolean}, github:{mode:"secret",name}|{mode:"none"}, options:{installTimeoutSec, trustProjectConfig,
  idleGraceSec, suspendAfterIdleSec, terminateAfterSuspendedSec, autoPush, maxDurationSec}, logGroup}`;
  `RunManifest` `{v, runId, owner, status, createdAt, updatedAt, microvmId?, endpoint?, imageVersion, repo,
  model, lastEntryId?, usage?, git:{workBranch,lastCommit?,prUrl?}, error?, continuedFrom?, timeline:[{status,at}]}`;
  `RunnerStatus`; SSE event envelope `{id, type, data}`; error shape `{error:{code,message}}`.
  Export JSON Schema to `docs/schemas/*.json` via a script. Size guard helper `assertPayloadFits`.
- Validate:
  1. `npm run test:unit -- shared` → round-trip tests, unknown `v` rejected, size guard rejects > 3.5 KB
     (limit constant from ADR-5/T0.4 result).
  2. `npm run schemas:gen` produces identical output on re-run (`git diff --exit-code docs/schemas`).
- Done when: schemas documented in `docs/protocol.md` stub (T1.3 completes it).

### T1.2 — Local and per-repo config schemas + loader — S/M
- Depends on: T1.1 [parallel-ok]
- Do: `shared/config.ts`: `LocalConfig` `{aws:{profile?,region}, stackName, image:{name,memoryMiB},
  defaults:{model, maxDurationHours, idle:{suspendAfterMin, terminateAfterSuspendedMin}, maxConcurrent,
  archiveRetentionDays, controllerCadenceMin}, providers:{synced:string[], oauthOptIn:string[], bedrockRole:boolean, syncedAt?},
  github:{mode,secretName?}, kmsKeyArn?, egressConnectorArn?}`;
  `RepoConfig` (`.pi/cloud-agents.json`): `{install?, start?, env?, secrets?:string[], model?, memoryMiB?}`.
  `extension/config.ts`: load/save `~/.pi/agent/pi-cloud-agents.json` honoring `PI_CODING_AGENT_DIR`,
  atomic write, mode 0600, defaults, readable validation errors.
- Validate:
  1. Unit tests: defaults applied; corrupt JSON → error names the path and line; saved file mode is 0600.
  2. `RepoConfig` rejects secrets not matching `/pi-cloud-agents/<stack>/...` pattern.
- Done when: both schemas exported to `docs/schemas/`.

### T1.4 — pi config bundle builder (`core/pi-config`) — M
- Depends on: T1.1, T0.6
- Do: pure functions (no pi runtime): `buildBundle({authEntries, modelsJson?, settingsSubset,
  agentsMd?, skills?})` → `{secrets: Map<provider, authEntryJson>, bundleTar: Buffer, manifest}`;
  size checks (Secrets Manager value ≤ 64 KB; warn > 16 KB); default provider set = **all
  providers with credentials** minus OAuth providers not opted in;
  `settingsSubset` allow-list (defaultProvider/Model/ThinkingLevel, compaction, retry,
  thinkingBudgets — never `packages`/`extensions` paths); deterministic tar (fixed mtimes);
  `assemblePiAgentDir(bundleTar, secrets, targetDir)` used by the runner to write
  `auth.json` (0600), `models.json`, `settings.json`, `AGENTS.md`.
- Validate: unit tests: round-trip build→assemble equals inputs; tier selection; disallowed
  settings dropped; secrets never inside the tar (grep test).
- Done when: green; used by T2.2 (runner) and T4.13 (`/cloud sync`).

### T1.3 — Runner API contract document — S
- Depends on: T1.1
- Do: `docs/protocol.md`: endpoints, methods, request/response schemas (link JSON schemas),
  status codes, SSE cursor semantics (`Last-Event-ID` = pi entry id), WS passthrough framing (LF
  JSONL, one command per frame), error codes, token/port rules.
- Validate: `tests/unit/protocol-doc.test.ts` asserts every route in the doc's route table exists
  in `runner/api.ts` route registry (test may be skipped until T2.5a, then must pass).
- Done when: doc reviewed against `01-architecture.md §8`.

---

## Phase 2 — Runner (in-VM runtime), local-first

### T2.1 — Lifecycle hook server — M
- Depends on: T1.1
- Do: `runner/hooks.ts`: HTTP server bound `0.0.0.0:9000`; routes under
  `/aws/lambda-microvms/runtime/v1/`; `ready` 503 until `runner.initialized`; `validate` runs
  self-check (pi binary, git, disk) → 200/503; `run` parses body `{microvmId, runHookPayload}`,
  validates `LaunchPayload`, emits `run` event, returns 200 in < 200 ms (invalid payload → still
  200 + mark run `failed` with reason so the VM can report it, and schedule self-terminate
  after the manifest is written); `resume`/`suspend`/`terminate` await `Lifecycle` handlers with
  a deadline (`timeout - 2 s`) and always answer 200; all idempotent; unknown hook → 200.
- Validate:
  1. `npm run test:unit -- runner/hooks` → status code matrix, idempotency, `run` latency < 200 ms,
     `suspend` returns within deadline even if handler hangs.
- Done when: tests green; hooks documented in `docs/protocol.md`.

### T2.2 — Launch payload handling, secrets, and pi config assembly — M
- Depends on: T2.1, T1.4
- Do: `runner/secrets.ts`: `SecretsProvider` interface `{get(name)}`; `SecretsManagerProvider`
  (`GetSecretValue`, retries, handles `AWSCURRENT`), `FakeSecretsProvider`; `runner/pi-config.ts`: download
  the bundle (`StorageSink.getObject(bundleKey)`), fetch `authParams`, call
  `assemblePiAgentDir()` into `/work/.pi-agent` (0700), set `PI_CODING_AGENT_DIR`, `PI_OFFLINE`
  unset (models need network), `AWS_REGION` for Bedrock; GitHub token → `GITHUB_TOKEN`/`GH_TOKEN`
  in the pi env only; register every secret value with `runner/logger.ts` (structured JSON,
  `registerSecret(value)` redaction, levels).
- Validate:
  1. Unit tests: assembled dir matches bundle; missing param → run `failed` with code `SECRET_MISSING`;
     `auth.json` mode is 0600; the pi env contains no `*_API_KEY` values for providers not in `authParams`.
  2. Logger test: after `registerSecret("abc123")`, `log.info({cmd:"echo abc123"})` output contains
     `[REDACTED]` and not the value; also redacts inside nested objects and arrays.
- Done when: no code path logs raw env or auth entries.

### T2.3 — Workspace preparation (git + install) — M
- Depends on: T2.2
- Do: `runner/workspace.ts`: clone `repo.url` at `ref` into `/work/repo` (`--depth` from payload,
  `--filter=blob:none` optional), create `workBranch`, set `user.name/email` (`pi-cloud-agents[bot]`
  or configured); credentials via `GIT_ASKPASS=/opt/pi-cloud/askpass.sh` reading `GITHUB_TOKEN`
  (never in `.git/config`; verify with a test); run `RepoConfig.install` with `bash -lc`, timeout
  `installTimeoutSec`, output to log + `install.log`; `start` commands spawned detached with logs;
  restore-from-archive path: `restoreFrom` prefix → download `archive.tar.zst` + `session.jsonl`
  (implemented fully in T5.3; here define the interface and a fake).
- Validate:
  1. Integration test with a local bare repo (`file://`): clone, branch created, commit works.
  2. Test asserts `git config --get remote.origin.url` contains no token and `.git/config` has no `token`.
  3. Install script timeout test (sleep 30 with 2 s limit) → run `failed` with `INSTALL_TIMEOUT`, log captured.
- Done when: tests green on macOS and Linux CI.

### T2.4 — pi process manager (RPC bridge) — M
- Depends on: T2.2
- Do: `runner/pi-process.ts`: spawn `pi --mode rpc --session-dir /work/.pi-sessions [--approve]
  [--provider P --model M [--thinking T]] [-e <in-VM extensions>]` with cwd `/work/repo` and the
  env from T2.2 (`PI_CODING_AGENT_DIR=/work/.pi-agent`, so pi's own `ModelRuntime` resolves the
  synced credentials/models); LF-only JSONL parser (reuse pi's exported `RpcClient` if it can wrap child streams,
  else implement per `docs/rpc.md`); request/response correlation by `id`; event fan-out;
  `get_state` health probe; crash → one restart with `--session <file>` continuation, second crash →
  run `failed`; graceful stop (`abort` → SIGTERM → SIGKILL deadline).
- Validate:
  1. Unit tests with `tests/fakes/fake-pi.ts` (a Node script speaking the RPC protocol): prompt →
     events → `agent_settled`; crash/restart path; U+2028 inside a JSON string does not split records.
  2. `PI_CLOUD_REAL_PI=1 npm run test:integration -- pi-process` → real `pi` with `mock-llm`
     extension completes a scripted prompt (tool call + final text).
- Done when: both suites green.

### T2.5a — Runner HTTP API (REST + SSE) — M
- Depends on: T2.4, T1.3
- Do: `runner/api.ts` on `:8080`: `GET /v1/status`, `POST /v1/prompt`, `POST /v1/abort`,
  `GET /v1/entries?since=`, `GET /v1/events` (SSE; replays entries since `Last-Event-ID`/`since`,
  then live; heartbeat comment every 15 s), `POST /v1/checkpoint` (flush now), `POST /v1/shutdown`;
  JSON errors per protocol; request size limit 1 MB; route registry exported (for T1.3 test).
- Validate:
  1. Integration tests against fake pi: prompt while idle OK; prompt while streaming without mode → 409
     with hint; SSE replay from cursor yields exactly the missed events; heartbeat observed.
  2. `protocol-doc.test.ts` (T1.3) now passes un-skipped.
- Done when: `docs/protocol.md` matches implementation.

### T2.5b — Runner WebSocket RPC passthrough — M
- Depends on: T2.5a
- Do: `GET /v1/rpc` upgrade (`ws`): client frames → pi stdin (validate JSON, LF framing); pi
  events → all clients; `extension_ui_request` delivered to the *attached* client (most recent
  `attach` frame), auto-`cancelled` response after 120 s if none; backpressure (drop `message_update`
  deltas for slow clients, never drop `message_end`/`agent_*`).
- Validate: integration tests with two `ws` clients (fan-out, attached-client routing, slow client).
- Done when: documented in `docs/protocol.md`.

### T2.6 — Run state machine and persistence — M
- Depends on: T2.2
- Do: `runner/state.ts`: `RunStateMachine` with allowed transitions
  (`provisioning→ready→running↔idle→suspended→running`, any→`failed|terminated`, `idle→finished`);
  `runner/storage.ts`: `StorageSink` `{putManifest, putSession, putArchive, getObject}` with
  `S3StorageSink` (put with `If-None-Match`-free overwrite, retries) and `LocalStorageSink`;
  manifest written on every transition; `session.jsonl` mirrored debounced (5 s) while streaming
  and flushed on `agent_settled`, suspend, terminate; `lastEntryId` maintained from pi entries.
- Validate:
  1. Unit tests: illegal transitions throw; timeline appended; manifest JSON validates against schema.
  2. Integration test with `LocalStorageSink` + fake pi: after `agent_settled` the mirrored
     `session.jsonl` byte-equals pi's session file; flush ordering on `terminate` (session before manifest `terminated`).
- Done when: green.

### T2.7 — Lifecycle policy (idle reporting, finalize, resume recovery, max duration) — M
- Depends on: T2.5a, T2.6
- Do: `runner/lifecycle.ts`: attached-client tracking (SSE/WS connections + last `/v1/status` poll
  per client id); compute and expose in `/v1/status` the fields the controller decides on:
  `agent.state`, `attachedClients`, `idleSince`, `policy` (from the payload: `idleGraceSec`,
  `maxDurationSec`), `suggestedAction: none|suspend|terminate` (advisory — the controller decides;
  the runner never calls `lambda:*`); auto-commit WIP to `workBranch` after each `agent_settled`
  (`pi-cloud: checkpoint <n>`), push if `autoPush`; on `/suspend` and `/terminate`: flush session +
  manifest within the hook deadline; on `/resume`: mark state, re-create outbound HTTP clients and
  retry any in-flight upload (outbound connections are killed by the platform on resume); at
  `maxDurationSec - 15 min` emit a `warning` event + checkpoint (archive) so T5.3 can continue.
- Validate:
  1. Unit tests with fake clock: `idleSince`/`suggestedAction` transitions; finalize completes
     within a 5 s deadline with a large repo fake (time-boxed push); resume recovery retries a
     failed upload once.
  2. Integration: auto-commit appears in the local bare repo after a scripted turn.
- Done when: behavior table added to `docs/protocol.md`.

### T2.8 — Local harness, mock LLM, and Gate G2 script — M
- Depends on: T2.3, T2.5b, T2.7, T2.10
- Do: `scripts/dev/run-local.ts`: starts the runner with `FakeSecretsProvider`, `LocalStorageSink`
  (`.tmp/runs/`), a fake hooks driver that POSTs `/run` with a sample payload pointing at a local
  bare repo, real `pi` + `mock-llm`; `scripts/dev/client.ts`: sends a prompt, streams SSE to stdout,
  prints final status. `npm run e2e:local` wires them and asserts outcomes.
- Validate:
  1. `npm run e2e:local` → exit 0; asserts: manifest reaches `idle` then `finished` after
     `/v1/shutdown`; `session.jsonl` mirrored; work branch has a checkpoint commit containing
     `hello.txt`; no secret value appears in `.tmp/runs/**` or logs (grep for the fake token).
  2. Runs in CI (Linux) in < 3 min.
- Done when: T2.8 validation passes; then run gate G2.

### G2 — Gate: local end-to-end run (no AWS) — S
- Depends on: T2.8
- Checklist: `npm run e2e:local` green in CI and locally; `docs/protocol.md` matches `runner/api.ts`
  (T1.3 test passes); evidence for T2.1–T2.8 present; no secret values in `.tmp/runs/**` (grep);
  reviewer has read the harness output once end to end.
- Passed when: owner or reviewer marks `G2 passed` in STATUS.md. Unblocks Phase 4 skeleton work
  (T4.1a) and the image bundle (T2.9).

### T2.10 — Runner metrics and lifecycle timeline — M
- Depends on: T2.5a, T2.6
- Do: `runner/metrics.ts` implementing the catalogue in `07-ux-and-observability.md §3`:
  lifecycle timestamps (launch, RUNNING, `/run`, secrets, clone, install, ready, first prompt,
  last activity, suspend/resume); agent counters from pi events (turns, tool calls by tool,
  prompts, errors, retries, compactions, current tool + elapsed, last event age); model stats
  from `get_session_stats` plus measured time-to-first-token and turn durations; workspace stats
  (`git diff --shortstat` vs base, commits, last checkpoint/push); VM samples every 5 s from
  `/proc` (load, mem, disk on `/work`, egress bytes) in a 6 h ring buffer; `events/min` series.
  Exposed as a summary in `GET /v1/status`, in full at `GET /v1/metrics`, and as periodic
  `metrics` SSE frames (every 5 s while a client is attached). Never fabricated: a metric that
  cannot be measured is omitted, not defaulted.
- Validate:
  1. Unit tests with fake pi + fake clock: counters, TTFT/turn timing, timeline durations, ring buffer bounds.
  2. Integration in `e2e:local`: `/v1/metrics` after the scripted run shows `toolCalls.bash ≥ 1`,
     a complete timeline, and VM samples (Linux CI) or omitted fields (macOS).
- Done when: `docs/protocol.md` documents `/v1/metrics` and the SSE frame.

### T2.9 — Runner bundle, image Dockerfile, deterministic image zip — M
- Depends on: T2.8, T0.5
- Do: esbuild `runner/main.ts` → `dist/runner/index.js` (platform node, target node22, single file,
  source map external); `image/Dockerfile` final (base al2023-minimal; Node 22; git, tar, gzip, zstd,
  which, findutils, procps-ng, ca-certificates; optional `gh` CLI arm64; `npm i -g pi@<pinned>`;
  copy runner + in-VM pi extensions + `askpass.sh`; `ENV HOOK_PORT=9000 HOME=/root`; `WORKDIR /work`;
  `ENTRYPOINT ["node","/opt/pi-cloud/runner.js"]`); `scripts/build-image-zip.ts` → `dist/image/app.zip`
  with fixed mtimes/ordering + `dist/image/manifest.json` `{sha256, piVersion, runnerVersion, builtAt}`;
  `npm run build` also builds `dist/controller.zip` placeholder (T3.5 fills it).
- Validate:
  1. `npm run build && sha256sum dist/image/app.zip` twice → identical hash; `unzip -l` shows
     `Dockerfile` at zip root; size < 5 MB.
  2. If Docker is available: `docker build --platform linux/arm64 -f image/Dockerfile .` succeeds
     (optional, record if skipped).
- Done when: `dist/` artifacts are included by `npm pack --dry-run`.

---

## Phase 3 — Infrastructure

### T3.1a — CloudFormation core stack — M
- Depends on: G2 [parallel-ok after T1.1]
- Do: `infra/core.yaml`: parameters (`ImageName`, `LogRetentionDays`, `ArchiveRetentionDays`,
  `KmsKeyArn?`); S3 bucket (BlockPublicAccess, SSE, lifecycle: expire `runs/` after N days, abort
  incomplete multipart 1 day), log groups `/aws/lambda/microvms/<ImageName>` + `/pi-cloud-agents/<stack>/controller`
  (IAM statements cover both documented prefixes `/aws/lambda/microvms/*` and `/aws/lambda-microvms/*`
  until T0.3 records the real one), `BuildRole` and `ExecutionRole` with trust policies for
  `lambda.amazonaws.com` (`sts:AssumeRole` + `sts:TagSession`) **with confused-deputy conditions**
  (`aws:SourceAccount` = account, `aws:SourceArn` like `arn:aws:lambda:<region>:<account>:microvm-image:*`);
  `BuildRole`: `s3:GetObject` on `runner/*` + logs; `ExecutionRole`: least privilege per
  `01-architecture.md §5` — S3 `runs/*` rw + `config/*` read, Secrets Manager read on the stack
  prefix (+ `kms:Decrypt` when `KmsKeyArn` set), logs, Bedrock statement conditional on parameter
  `EnableBedrock`, **no `lambda:*`**; `OperatorPolicy` managed policy (CloudFormation, S3 bucket
  ops, Secrets Manager on the stack prefix, `lambda:*Microvm*` on this image, `lambda:PassNetworkConnector`
  on `arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:*` + optional custom
  connector ARN, logs read, sts, `lambda:ListManagedMicrovmImages`/`ListManagedMicrovmImageVersions`),
  optional `KmsKeyArn`, outputs (bucket, role ARNs, policy ARN).
- Validate:
  1. `npx cfn-lint infra/core.yaml` → 0 errors.
  2. `tests/unit/infra-policies.test.ts` parses the template and asserts no `Resource: "*"` except an
     allow-list (`ListMicrovms`, `ListMicrovmImages`, `sts:GetCallerIdentity`, `ecr:GetAuthorizationToken`).
- Done when: policies documented in `docs/iam.md` (what the user must have vs what roles get).

### T3.1b — CloudFormation image stack (MicrovmImage + controller) — M
- Depends on: T3.1a
- Do: `infra/image.yaml`: parameters (`ArtifactBucket`, `RunnerArtifactKey`, `ControllerArtifactKey`,
  `ImageName`, `MemoryMiB`, `BuildRoleArn`, `ExecutionRoleArn`, `BaseImageArn`, `BaseImageVersion`,
  `ImageLogGroup`); `AWS::Lambda::MicrovmImage` — **all properties are required by the resource**:
  `Name`, `Description`, `BaseImageArn`, `BaseImageVersion`, `BuildRoleArn`, `CodeArtifact.Uri`,
  `CpuConfigurations: [{Architecture: ARM_64}]`, `AdditionalOsCapabilities: []`,
  `EgressNetworkConnectors: []` (connectors are passed at run time), `EnvironmentVariables`
  (`PI_CLOUD_STACK`, `PI_CLOUD_BUCKET`, `PI_CLOUD_LOG_GROUP`, `HOOK_PORT=9000`), `Hooks` (port 9000;
  image hooks ready 120 s / validate 120 s; VM hooks run 30 s, resume 15 s, suspend 45 s,
  terminate 45 s — never rely on the 1 s defaults), `Logging: {CloudWatch: {LogGroup}}`,
  `Resources: [{MinimumMemoryInMiB}]`, `Tags`; controller Lambda (arm64, code from
  `ArtifactBucket/controller/<sha>.zip`), its role (T3.5), EventBridge `rate(1 minute)` rule with
  permission; outputs image ARN, `LatestActiveImageVersion`, controller function name.
- Validate:
  1. `npx cfn-lint infra/image.yaml` → 0 errors; template test asserts every required property is set.
  2. Note in `02-decisions.md` ADR-3 that the resource documents an **asynchronous build** — the
     deployer (T3.3) must still poll `GetMicrovmImage`; G3 records whether CloudFormation waits.
- Done when: template validated live in G3.

### T3.2 — Stack deployer module — M
- Depends on: T3.1b
- Do: `extension/aws/stack.ts`: `deployStack({name, templateBody, parameters, tags})` using change
  sets (`CreateChangeSet` → `DescribeChangeSet` → execute or no-op on `NO_CHANGES`), waiters with
  progress callback (stack events streamed), failure → collect `ResourceStatusReason`s; `getOutputs`;
  `deleteStack` with wait; `emptyBucket` helper (versions aware).
- Validate: unit tests with `aws-sdk-client-mock`: create, update, no-change, rollback failure
  surfaces reasons; delete path empties bucket first.
- Done when: green.

### T3.3 — Image manager (upload + build + wait + diagnostics) — M
- Depends on: T3.2, T2.9
- Do: `core/aws/image.ts`: upload `dist/image/app.zip` to `runner/<sha>.zip` and
  `dist/controller.zip` to `controller/<sha>.zip` (skip if exist); resolve the latest managed base
  image + version via `ListManagedMicrovmImages`/`ListManagedMicrovmImageVersions` (state
  `AVAILABLE`); build via image stack parameter update (or SDK `Create/UpdateMicrovmImage`
  fallback); **always** poll `GetMicrovmImage` until image `CREATED|UPDATED` and the new version is
  `SUCCESSFUL` + `ACTIVE` (poll 10 s, ≤ 20 min) even after the stack reports complete; on failure
  fetch the last 50 lines of the build log group; `describeImage()` returns `{arn, version,
  runnerSha, piVersion, baseImageVersion, memorySnapshotBytes}` (from `GetMicrovmImageBuild`) for
  drift checks and the dashboard; `pruneVersions(keep=2)` deactivates and deletes older versions
  (versions cost storage even when unused).
- Validate: unit tests (mock) for success, failure-with-logs, base-version resolution, drift
  detection (sha mismatch → `needsUpdate`), prune keeps the active + one previous version.
- Done when: green; used by T4.3b.

### T3.4 — Secrets store (AWS Secrets Manager) — S/M
- Depends on: T1.2 [parallel-ok]
- Do: `core/aws/secrets.ts`: names `pi-cloud-agents/<stack>/pi-auth/<provider>`,
  `pi-cloud-agents/<stack>/github/token`, `pi-cloud-agents/<stack>/runs/<runId>/<name>`;
  `put` (`CreateSecret` or `PutSecretValue`, tags incl. owner, optional `KmsKeyId`), `exists`,
  `delete` (`ForceDeleteWithoutRecovery` for run-scoped and on destroy; recovery window otherwise),
  `listRunScoped` (`ListSecrets` with name filter — never fetches values); never returns values
  to the UI; input via `ctx.ui.input` masked where supported.
- Validate: unit tests (mock) incl. name validation, create-vs-update path, force delete only for
  run-scoped/destroy, and that `list` never calls `GetSecretValue`.
- Done when: green.

### T3.5 — Controller Lambda (keepalive, idle policy, janitor) — M
- Depends on: T2.6 (manifest schema), T2.7 (status fields), T3.1b
- Do: `infra/controller/handler.ts` (Node 22 arm64, EventBridge `rate(1 minute)`, reserved
  concurrency 1, timeout 50 s): `ListMicrovms` for the image → for each RUNNING VM: locate the
  manifest via `index/<microvmId>` → mint a token (port 8080, 5 min) → `GET /v1/status` (keepalive)
  → decide: `suggestedAction=suspend` and `idleSince` ≥ `idleGraceSec` → `SuspendMicrovm`;
  `finished|failed` > 10 min → `TerminateMicrovm`; no manifest after 20 min or age >
  `maxDurationSec + 10 min` → terminate; unreachable status 3 polls in a row → mark `unhealthy` in
  the manifest (terminate after 15 min); SUSPENDED VMs: nothing (platform `suspendedDurationSeconds`);
  force-delete `runs/<runId>/*` secrets for TERMINATED runs; write `controller/last-run.json`
  (timestamp, counts, decisions); structured logs; `DryRun` env; exponential backoff on throttling
  (`SuspendMicrovm` 2 TPS). Role: `lambda:ListMicrovms/GetMicrovm/SuspendMicrovm/TerminateMicrovm/
  CreateMicrovmAuthToken` on this image, S3 read/write on `runs/*`, `index/*`, `controller/*`,
  `secretsmanager:DeleteSecret` on `runs/*`. Bundled by `npm run build` to `dist/controller.zip`.
- Validate: unit tests with mocks covering the decision table (incl. unhealthy path, throttling
  backoff, dry run); bundle < 2 MB; a fake-runner integration test proves that a `running` status
  is never suspended and an idle one is.
- Done when: deployed and observed in G3 (`controller/last-run.json` updates every minute).

### G3 — Gate: live infra smoke [AWS] — M
- Depends on: T3.2–T3.5, T2.9
- Do: `tests/e2e/aws-infra.test.ts` (env-gated): deploy core → upload zip → deploy image (wait) →
  put a fake LLM secret → `RunMicrovm` with a `LaunchPayload` pointing at a public sample repo and
  `mock-llm` (no tokens spent; `maxDuration 1800`) → token → `/v1/status` reaches `ready` → prompt →
  `idle` → controller suspends it within `idleGraceSec` + 2 min (observe SUSPENDED) → a status
  request auto-resumes it → manifest + `session.jsonl` present in S3 → terminate →
  `controller/last-run.json` updated within 2 min → verify CloudFormation stabilized the image
  (`GetMicrovmImage` state at stack completion recorded) → destroy both stacks → cleanup verification.
- Validate: `PI_CLOUD_E2E=1 npm run e2e:aws -- infra` → exit 0; evidence has timings + cost estimate.
- Passed when: reviewer confirms evidence and no leftovers.

---

## Phase 4 — Local extension (pi package UX)

### T4.1a — Extension skeleton, `/cloud` router, `/cloud doctor` — M
- Depends on: G2 [parallel-ok]
- Do: `extension/index.ts`: register `/cloud <sub> [args]` with `getArgumentCompletions` for
  sub-commands and run ids; sub-commands stubbed with "not implemented" notices; `/cloud help`;
  `/cloud doctor` prints a green/red table: config path/validity, AWS identity (masked) + region +
  MicroVM availability, stack states, image drift, pi version, synced providers, concurrency;
  footer badge via `ctx.ui.setStatus("cloud", "cloud n running · m idle")` (text, theme `muted`)
  refreshed from a 30 s cached fleet poll only while idle; guard all UI with `ctx.hasUI`.
- Validate:
  1. Unit tests for router parsing/completions.
  2. `pi --no-extensions -e ./extension/index.ts --mode rpc --no-session` + `{"type":"prompt","message":"/cloud doctor"}`
     → `extension_ui_request` notify with a doctor report (no crash without config).
- Done when: green.

### T4.1b — UI kit and style compliance (no-emoji lint) — M
- Depends on: T4.1a
- Do: `extension/ui/kit.ts` implementing `07-ux-and-observability.md §1`: `glyph` constants (the
  allowed set only), `badge(state)`, `table(rows, cols, {align})` with `visibleWidth` padding and
  `truncateToWidth`, `kv()`, `duration()`, `bytes()`, `money()` ("est." marker), `pct()`,
  `sparkline()`, `timeline()`, `stepList()` (state glyph, label, detail, elapsed, ETA), theme-
  aware via the injected `theme`; `tests/unit/ui-style.test.ts` scanning `extension/`, `cli/`,
  `core/`, `README.md`, `docs/**/*.md` for forbidden code points (§1.1) — wired into
  `npm run check`; a biome/eslint rule forbidding string tables outside `ui/kit.ts` (or a test).
- Validate:
  1. Kit snapshot tests at 80/120 cols, dark and light themes; every helper width-safe.
  2. `ui-style.test.ts` fails on a fixture containing an emoji and passes on the repo.
- Done when: all later UI cards import from the kit (checked in review).

### T4.2 — AWS client factory and error mapping — S/M
- Depends on: T1.2
- Do: `extension/aws/clients.ts`: `fromNodeProviderChain({profile})`, region, memoized clients
  (`LambdaMicrovms`, `CloudFormation`, `S3`, `SecretsManager`, `STS`, `CloudWatchLogs`, `KMS`), adaptive retry,
  `mapAwsError()` → user-facing messages (`AccessDeniedException` lists the missing action and
  points to `OperatorPolicy`; `ServiceQuotaExceededException` → quota hint; region without
  MicroVMs → list of supported regions).
- Validate: unit tests for error mapping; `doctor` uses it.
- Done when: green.

### T4.3a — `/cloud setup` wizard (UI + config) — M
- Depends on: T4.1a, T4.1b, T4.2, T3.4
- Do: `core/setup/steps.ts` step machine over the `Prompter` interface, with the pi adapter
  (`extension/prompter-pi.ts`). **Quick setup is the default**: one summary screen (detected
  profile/region, providers found locally, sizing, estimated monthly cost, what will be created)
  with `Create` / `Customize` / `Cancel`; `Customize` opens the full wizard: (1) preflight
  (identity, region support, permission probe with remediation per §4 of the UX doc),
  (2) AWS profile/region select (from `~/.aws/config` + MicroVM regions, default us-east-1),
  (3) providers to sync: list local providers that have credentials (from `ctx.modelRegistry`),
  pre-select the current default model's provider; API-key providers selectable freely; OAuth
  providers shown only if T0.6 marked them portable, off by default, with the ToS notice;
  `Enable Bedrock via IAM role` toggle, (4) GitHub: paste fine-grained PAT / skip, (5) sizing &
  budget defaults (editable later in `/cloud config`), (6) summary + confirm; `--dry-run` prints
  the plan; writes config (no secrets); re-runnable (pre-fills current values).
- Validate: unit tests drive the step machine with a scripted `Prompter` (happy path,
  back/cancel, OAuth gating, provider without credentials rejected); manual TUI run recorded.
- Done when: green.

### T4.3b — `/cloud setup` execution (deploy + image + secrets) — M
- Depends on: T4.3a, T3.2, T3.3
- Do: `core/setup/run.ts` orchestrates: ensure core stack → upload runner + controller zips →
  deploy image stack (progress via `Prompter.progress`; cancel-safe: stacks are idempotent) →
  build and upload the pi config bundle (T1.4) + auth secrets → GitHub token → write config →
  hand off to verify (T4.3d) → "ready: /cloud new". Resumable: a step ledger in the config
  dir skips completed steps; failures show the exact AWS error + next action.
- Validate: integration test with mocked AWS clients runs all steps and the resume path; live in G4.
- Done when: green.

### T4.3c — Standalone CLI (`npx pi-cloud-agents …`) — M
- Depends on: T4.3b
- Do: `cli/main.ts` (`bin` in package.json, Node 22, no pi runtime): commands `setup [--verify]
  [--dry-run] [--profile] [--region] [--non-interactive --config <file>]`, `verify [--with-model]`,
  `doctor`, `update`, `destroy`; terminal `Prompter` (readline/`@inquirer/prompts`), colored
  progress, JSON output flag; provider credential discovery without pi's runtime: read
  `~/.pi/agent/auth.json` + env vars using the same provider→env-var table pi uses (document the
  source), or `--skip-providers` to sync later from the TUI (`/cloud sync`).
- Validate:
  1. `npx . setup --dry-run --non-interactive --config tests/fixtures/setup.json` prints the plan, exit 0.
  2. Unit tests for arg parsing and the terminal prompter; `npm pack` includes `cli/`.
- Done when: green; README shows the one-liner.

### T4.3d — Verification engine and `/cloud verify` — M
- Depends on: T4.3b, T4.5, T2.8 (mock-llm)
- Do: `core/verify/`: static checks (identity, region, stacks, bucket policy/encryption, image
  ACTIVE + runner sha matches package, secrets present for synced providers, controller schedule
  enabled and `controller/last-run.json` < 2 min old, operator has `lambda:PassNetworkConnector`,
  config file valid) + **smoke run** (launch with `mock-llm`, `maxDuration 900`,
  tagged test; wait RUNNING ≤ 30 s, ready ≤ 3 min, prompt → bash tool call observed, idle,
  suspend, resume, status, terminate, S3 manifest+session present, cleanup verified) + **model
  check** (default on when a provider is synced: one real 1-line prompt with the user's default
  model inside the smoke VM before terminate, asserting a non-error assistant message; `--no-model`
  skips; cost ≈ $0.01) → report `{checks:[{id,status,detail,remediation}]}`; TUI shows a live
  checklist; CLI prints a table; non-zero exit on failure. Output uses the kit's `stepList`
  (§2.6 layout: glyph, check name, detail, duration, ETA for the image build) and ends with a
  one-paragraph plain-language verdict including measured timings and the cost of the check.
- Validate:
  1. Unit tests for each static check with mocked clients (pass/fail/remediation text).
  2. Integration: smoke run against the in-process runner + fake proxy passes; a forced failure
     (e.g. image sha mismatch) produces the expected ✗ + remediation.
  3. Live in G3/G4.
- Done when: green.

### T4.4 — `/cloud new` launch flow — M
- Depends on: T4.3b, T1.1
- Do: `extension/commands/new.ts`: repo detection (`git remote get-url origin`, current branch,
  dirty-tree warning), prompt via `ctx.ui.editor` (or args), model select from the local pi's
  available/scoped models (`ctx.modelRegistry`, `ctx.scopedModels`) — any model pi supports;
  if the model's provider is not synced (or is OAuth without opt-in) offer `/cloud sync` (T4.13)
  or Bedrock; `RepoConfig` read from the repo; build `LaunchPayload` (+ size guard); write
  `runs/<runId>/manifest.json{launching}` and `index/<microvmId>` after `RunMicrovm`; `RunMicrovm`
  with `imageIdentifier` = **image ARN** (bare names are rejected) + explicit `imageVersion`,
  `clientToken=runId`, ingress `HTTP_INGRESS` (+ `SHELL_INGRESS` when `enableShell`) and egress
  (config connector | `INTERNET_EGRESS`) — requires `lambda:PassNetworkConnector`; safety-net idle
  policy (ADR-4: `maxIdleDurationSeconds` 1200, `suspendedDurationSeconds` from config,
  `autoResumeEnabled` true), `maximumDurationInSeconds`, CloudWatch logging, payload; wait RUNNING →
  mint token → poll `/v1/status` until `ready` (≤ 5 min, show provisioning steps) → `POST /v1/prompt`
  initial task → notify run id + `/cloud attach <id>` hint; enforce `maxConcurrent`.
- Validate: unit tests with mocks (payload size, concurrency cap, failure before RUNNING marks
  manifest `failed`); integration against in-process runner (T2.8 harness) for the ready-poll path.
- Done when: green; live in G4.

### T4.5 — Run client (tokens, HTTP, SSE, WS) — M
- Depends on: T2.5b, T4.2
- Do: `core/client/run-client.ts`: `CreateMicrovmAuthToken` (port 8080, 30 min; API max is 60)
  with refresh at T-5 min, reading the `X-aws-proxy-auth` entry of the returned token map; `fetch`
  with `X-aws-proxy-auth` + `X-aws-proxy-port: 8080`; 403 → re-mint once; 502 → treat as resuming
  (retry with backoff up to 60 s); SSE consumer with `Last-Event-ID` cursor and reconnect; WS RPC
  client (Node 22 global `WebSocket`, subprotocols `lambda-microvms`,
  `lambda-microvms.authentication.<token>`, `lambda-microvms.port.8080`) for attach; while attached,
  `GET /v1/status` every 60 s (RTT metric + keepalive traffic, ADR-4).
- Validate: integration tests against the real runner in-process (fake pi) behind a tiny fake proxy
  that enforces the header/port rules and can inject 403/502.
- Done when: green.

### T4.6 — `/cloud list` and `/cloud status <id>` — M
- Depends on: T4.5, T2.6
- Depends also on: T4.1b, T2.10
- Do: list = S3 manifests (`runs/*/manifest.json`, newest first, ≤ 50) merged with live
  `GetMicrovm` state and `/v1/status` summaries for non-terminal runs; table via `SelectList`
  built with the kit, columns per UX doc §2.2 (state glyph+word, run, repository#branch, model,
  activity, turns, tokens, est. cost, elapsed, last event age); selecting opens the action menu
  (attach / status / dashboard / logs / pr / stop); `status` renders the detail card of §2.3
  (timeline with durations, counters, model stats, VM cpu/mem/disk, checkpoints, region + VM id);
  cost estimate from `MemoryMiB` and running seconds using the rates table (config-overridable),
  labeled "est.".
- Validate: unit tests for merge + cost calc; snapshot tests of list and status at 80/120 cols
  from a fixture; no line exceeds width; `ui-style` lint passes.
- Done when: green.

### T4.7a — `/cloud attach`: mirror session core — M
- Depends on: T4.5, T4.6
- Do: `extension/ui/mirror.ts`: `ctx.newSession` named `cloud: <id>` (or `switchSession` to an
  existing mirror found via a `cloud-run` custom entry in `SessionManager.list`); `pi.appendEntry("cloud-run", {runId, cursor, owner})`;
  replay `/v1/entries?since=cursor` → `appendEntry("cloud-msg", …)` (idempotent by remote entry
  id; cursor persisted after each batch) with a basic renderer; live stream: SSE `message_update`
  deltas into `setWidget("cloud-live", …)` and finalized messages as entries; `setStatus` shows
  remote state; `/cloud detach` clears widgets and unbinds; the local LLM never runs in a mirror
  session (`before_agent_start` guard as defense in depth).
- Validate: unit tests for event→entry mapping incl. compaction/branch summaries and duplicate
  suppression; integration with the in-process runner (scripted fake pi): after attach, the local
  session contains exactly the remote entries; manual TUI recording in evidence.
- Done when: green.

### T4.7b — `/cloud attach`: input forwarding and controls — M
- Depends on: T4.7a
- Do: `input` handler active only in bound sessions: `/cloud …` commands pass through; other text →
  `POST /v1/prompt` with mode from `event.streamingBehavior` (`undefined`→prompt, `steer`, `followUp`)
  and return `{action:"handled"}`; `/cloud abort` → `/v1/abort`; shortcut `ctrl+alt+c` for abort;
  `extension_ui_request`s from the remote (e.g. remote extension confirm) rendered via local
  `ctx.ui.select/confirm/input` and answered over WS; images in prompts forwarded as base64.
- Validate: unit tests for mapping; integration: steering while remote streams reaches fake pi as
  `steer`; remote `confirm` round-trips.
- Done when: green.

### T4.7c — Rich renderers and remote footer — M
- Depends on: T4.7a
- Do: `extension/ui/renderers/`: assistant Markdown via pi's `Markdown` + `getMarkdownTheme()`;
  thinking blocks collapsed (respect pi's hidden-thinking setting); tool rows styled like pi's
  (`bash`: command header + output box, truncated with expand; `edit`: syntax-highlighted diff
  from `details.diff`; `read`/`write`/`grep`/`find`/`ls`: compact summaries; unknown tools:
  generic); `expanded` flag honored (pi's tool-expand key toggles); images rendered when the
  terminal supports them; remote errors, auto-retry and compaction events shown as notices;
  custom footer (`ctx.ui.setFooter`) per UX doc §2.5 (run id, state glyph, current tool +
  elapsed, turn, tokens, est. cost, context %, VM uptime, live/last-event age; right side model +
  thinking); `notify` on remote `agent_settled`/failure; all via the kit; all lines width-safe.
- Validate: snapshot tests of renderer output at 80/120 cols for a fixture transcript (bash, edit
  diff, thinking, error, compaction); footer test; `ui-style` lint; manual recording.
- Done when: green; UX reviewed by owner against `07-ux-and-observability.md §5`.

### T4.7d — Durability: auto-reattach, reconnect, laptop-close semantics — M
- Depends on: T4.7a, T4.5
- Do: on `session_start` (startup, `-c`, `/resume`): detect a `cloud-run` binding → auto-reattach
  (token, `/v1/status`, replay since cursor, reopen SSE/WS) with a "reconnecting…" status; if the
  VM is `SUSPENDED` the first request auto-resumes it (show "resuming VM…"); if TERMINATED show
  the final manifest state and offer `/cloud continue`; network loss/sleep → backoff reconnect
  without duplicate entries; `session_shutdown` closes streams cleanly; `/cloud list` marks the
  run that has a mirror session and offers "open mirror".
- Validate: integration with the fake proxy: (1) kill SSE for 90 s → resumes with no duplicates;
  (2) simulate suspended VM (502 then 200) → status flows; (3) restart the extension host
  (`session_shutdown` → `session_start` on the same file) → reattaches and replays only new
  entries; manual: quit pi, wait > idle, `pi -c` → the cloud session is shown live (recorded).
- Done when: green.

### T4.8 — Control commands: stop, suspend, resume, logs, pr, shell — M
- Depends on: T4.5
- Do: `stop` (confirm → `POST /v1/checkpoint` → `TerminateMicrovm` → manifest `terminated`);
  `suspend`/`resume` (`SuspendMicrovm`/`ResumeMicrovm`, wait state); `logs <id> [--follow]`
  (CloudWatch `FilterLogEvents` by `runId` field, tail into a custom entry, follow via polling);
  `pr <id> [title]` (`POST /v1/pr` → runner pushes work branch and creates a PR via GitHub REST
  with the token → URL); `shell <id>` (SHELL_INGRESS required at launch: config flag
  `enableShell`; `CreateMicrovmShellAuthToken` (≤ 60 min, use 15) → WebSocket to
  `wss://<endpoint>/shell` with subprotocols `lambda-microvms`, `lambda-microvms.authentication.<token>`,
  `lambda-microvms.port.8022` → raw tty inside `ctx.ui.custom`; token never logged; optional/advanced).
- Validate: unit tests with mocks for each; `pr` integration against a fake GitHub API server.
- Done when: green; `shell` may be marked experimental.

### T4.9 — `cloud_agent` tool for the local LLM — M
- Depends on: T4.4, T4.6, T4.8
- Do: `pi.registerTool({name:"cloud_agent", parameters: {action: StringEnum(["launch","status","result","steer","stop"]), …}})`
  with `promptSnippet` and `promptGuidelines` naming the tool ("Use cloud_agent to delegate long
  or independent coding tasks to an isolated cloud sandbox…"); `result` returns the final assistant
  text + branch/PR URL (truncated to 50 KB); `renderCall/renderResult` compact; persists launched
  run ids in `details` for session restore.
- Validate: unit tests; manual: local pi asked to "delegate X to a cloud agent and report back"
  launches and later fetches the result (recorded).
- Done when: green.

### T4.10 — `/cloud update` and `/cloud destroy` — M
- Depends on: T4.3b, T3.3
- Do: `update`: compare `dist/image/manifest.json` sha/pi version with `describeImage` → rebuild
  image version → deactivate previous version (keep 1 fallback); `destroy`: confirm (type stack
  name) → terminate all runs → optionally export archives → empty bucket → delete image stack →
  delete core stack → force-delete secrets under the stack prefix → remove config; prints what remains (nothing).
- Validate: unit tests (mock) for both; live in G4 teardown with cleanup verification.
- Done when: green.

### T4.11 — `/cloud config` settings screen — M
- Depends on: T4.1a, T4.1b, T1.2
- Do: `SettingsList`-based editor (pi `tui.md` pattern 3) for every default in `LocalConfig`:
  profile/region (changing after setup → guided migration notice), memory baseline (image
  property → prompts to run `/cloud update`), max duration (≤ 8 h), idle suspend/terminate
  minutes, max concurrent, archive retention, controller cadence (1 or 5 min), trust project config, auto-push,
  egress connector ARN, synced providers (toggle → `/cloud sync`), enable shell ingress; live
  validation; writes config atomically; CLI equivalent `pi-cloud-agents config set <k> <v>`.
- Validate: unit tests for validation/edit paths; snapshot of the list at 80 cols; manual recording.
- Done when: green.

### T4.12 — `/cloud open <run>`: native read-only viewer — S/M
- Depends on: T4.5
- Do: download the remote `session.jsonl` (from S3 mirror or `/v1/session` on the runner), rewrite
  the header `cwd` to a local placeholder and add `parentSession`/`cloud-run` marker, write to the
  local sessions dir, `ctx.switchSession(file)`; the `input` guard treats it as read-only (typing
  offers `/cloud attach` instead); refresh with `/cloud open <run>` again.
- Validate: integration: imported session renders with pi's native renderers (tool rows, tree);
  typing does not trigger the local LLM.
- Done when: green.

### T4.13 — `/cloud sync`: refresh the pi config bundle — S/M
- Depends on: T1.4, T3.4, T4.2
- Do: discover local providers with credentials via `ctx.modelRegistry` (`getAvailable()`,
  `getProviderAuth(id)`), read raw OAuth entries only for opted-in providers, build the bundle
  (T1.4), upload secrets + tar, record `syncedAt`/`providers` in config; `/cloud new` calls it
  automatically when the selected model's provider is not synced or the entry is older than N days.
- Validate: unit tests with a fake registry; secrets never written to disk locally; live in G4.
- Done when: green.

### T4.14 — `/cloud dashboard`: live fleet view and activity feed — M
- Depends on: T4.6, T4.5, T2.10, T4.1b
- Do: overlay (`ctx.ui.custom` with `overlay: true`) per UX doc §2.4: fleet summary line (counts by
  state, elapsed today, est. spend today/month, launch success rate, avg launch→ready), one row
  per active run with state glyph, activity, `events/min` sparkline (30 min), tokens, cost,
  elapsed, last-event age; activity feed (last 20 events across runs with timestamps, tool,
  exit/duration); key hints (enter attach · s status · l logs · x stop · r refresh · esc);
  refresh every 5 s from `/v1/status`/SSE `metrics` frames without blocking pi; when idle, show
  the last completed runs and the last verify result with timings. RPC mode falls back to a
  static table via `notify`/entries (no overlay).
- Validate: snapshot tests (80/120 cols, dark/light) from a fixture fleet; refresh loop stops on
  close (`session_shutdown` safe); integration with two in-process runners; manual recording.
- Done when: green; owner review.

### T4.15 — Hub, quick-setup polish, first-run experience, IAM helper — M
- Depends on: T4.3a, T4.3b, T4.3d, T4.1b
- Do: `/cloud` with no arguments opens the hub (UX doc §2.1) with live counts and last verify
  result; pre-setup state shows a single `Set up cloud agents (about N minutes)` item with the
  what-gets-created/cost summary; after setup a "next steps" card (start a run, attach, cost,
  stop); `pi-cloud-agents iam-policy` / `/cloud iam-policy` prints the least-privilege operator
  policy JSON, writes `pi-cloud-agents-operator-policy.yaml` (a CloudFormation template creating
  the managed policy) for an admin, and offers `--create-policy` to create/attach it directly when
  the caller has IAM permissions; a CloudFormation quick-create link is offered only if the release
  publishes the template to an S3 bucket (quick-create requires an S3 `templateURL` — optional,
  T5.8); setup preflight uses this in remediation; ETA text for the image build; all copy reviewed
  for the vocabulary in §1.7.
- Validate: unit tests for hub state machine (pre/post setup); snapshot tests; the **first-time-
  user test** script in `docs/testing/first-run.md` (fresh machine, fresh AWS profile, README
  only) with a ≤ 15 min target — run once by someone other than the implementer, notes recorded.
- Done when: green; first-run test recorded.

### G4 — Gate: real end-to-end cloud agent [AWS] — M
- Depends on: T4.1a–T4.15, G3
- Do (scripted where possible, recorded manually otherwise), on a machine with only AWS creds and
  a normal local pi login:
  1. **CLI path**: `npx pi-cloud-agents setup --verify` from a clean shell → all checks ✓.
  2. **TUI path**: `pi install ./` → `/cloud doctor` green → `/cloud new` on a fork of a public
     sample repo with the task "add a README section…" using the owner's normal pi model.
  3. **Laptop-close scenario**: `/cloud detach`, quit pi, wait past the idle threshold (VM
     suspends), relaunch `pi -c` → the mirror session auto-reattaches and shows the completed
     work; send a follow-up "also fix the typo in X" → VM resumes, agent continues, streamed live.
  4. `/cloud pr` opens a PR → `/cloud open` shows the native transcript → `/cloud stop` →
     `/cloud verify` still ✓ → `/cloud destroy` → cleanup verification.
  5. **UX and observability review**: walk through hub, list, status, dashboard, attach footer,
     verify output in dark and light themes; complete the checklist in
     `07-ux-and-observability.md §5` (no emoji anywhere, real live metrics, timelines, VM ids).
  6. **First-time-user test** (T4.15 script) executed by someone other than the implementer.
- Validate: evidence includes timings (setup total, image build, launch→ready, reattach and
  resume latency), total AWS + LLM cost, PR URL, recordings, the §5 checklist, the first-run
  notes (≤ 15 min), and the checklist "user only provided credentials" (no Docker/AWS CLI used).
- Passed when: owner confirms the experience meets the rich-mirroring and professional-UI bars.

---

## Phase 5 — Hardening, continuation, release

### T5.1 — In-VM secret redaction extension — M
- Depends on: G4
- Do: `runner/pi-extensions/redact.ts` loaded by the in-VM pi: `tool_result` and `message_end`
  handlers replace registered secret values (env var names passed via `PI_CLOUD_REDACT_ENV`) with
  `[REDACTED:<NAME>]`; also applied by the runner to SSE/WS payloads and the mirrored session.
- Validate: unit tests; `e2e:local` extended: `echo $GITHUB_TOKEN` appears redacted in the
  transcript, the mirrored `session.jsonl`, and the SSE stream.
- Done when: green.

### T5.2 — Run-scoped GitHub credentials (GitHub App) — M
- Depends on: G4
- Do: optional GitHub App mode: setup stores App id + private key in Secrets Manager (or uses a user-supplied
  installation); at launch the extension mints an installation token scoped to the target repo,
  stores it at `/runs/<runId>/github-token` (1 h validity; runner refreshes via `/v1` request to
  the client? → simpler: the extension refreshes and rewrites the param while attached; runner
  re-reads on 401); the controller deletes run-scoped secrets.
- Validate: unit tests with a fake GitHub API; live: PR created with the App identity.
- Done when: documented as recommended mode.

### T5.3 — Continuation across the 8-hour limit (`/cloud continue`) — M/L
- Depends on: G4, T2.3 restore interface
- Do: runner checkpoints `archive.tar.zst` (workspace minus `node_modules`/`.git` objects
  optional) + `session.jsonl` at T-15 min and on terminate; `/cloud continue <id>` launches a new
  VM with `restoreFrom` → runner restores files, fetches work branch, starts pi with
  `--session <restored file>` so the conversation continues; manifest links `continuedFrom/To`.
- Validate: local harness test of the restore path; live: continue a run and verify the agent
  recalls prior context (asks it to summarize what it did).
- Done when: green.

### T5.4 — Cost and budget guard — M
- Depends on: T4.6
- Do: enforce `maxConcurrent`; `maxDurationHours ≤ 8` validated; per-run est. cost in list/status;
  `/cloud doctor` month-to-date estimate from manifests; optional CloudWatch billing alarm
  (opt-in in setup; needs billing alerts enabled — documented); warning before launch if MTD > budget.
- Validate: unit tests.
- Done when: green.

### T5.5 — Networking options and private access docs — S/M
- Depends on: G4
- Do: config `egressConnectorArn` wired to `RunMicrovm`; setup asks optionally; docs for VPC egress
  (network connector creation is out of scope: link AWS docs), private registries, `HTTPS_PROXY`.
- Validate: unit test that the connector ARN is passed; doc reviewed.
- Done when: merged.

### T5.6 — Observability and diagnostics — M
- Depends on: T4.8
- Do: runner structured logs include `runId`, `microvmId`, `phase`; `/cloud diag <id>` writes a local
  bundle (manifest, `/v1/status`, `GetMicrovm`, last 200 log lines) with secrets redacted; runner
  emits metrics-ish log lines (provisioning duration, turns, tokens).
- Validate: unit tests; bundle contains no secret values (grep test).
- Done when: green.

### T5.7 — Security review gate (G5 part 1) — M
- Depends on: T5.1, T5.2, T5.4, T5.6
- Do: `docs/threat-model.md` finalized (boundaries, controls, residual risks, user guidance); IAM
  review against `docs/iam.md`; `npm audit --omit=dev` clean or triaged; `gitleaks` in CI;
  payload/manifest parser fuzz test (`fast-check`); dependency pinning; review checklist signed.
- Validate: CI job `security` green; checklist in evidence.
- Done when: reviewer sign-off.

### T5.9 — OAuth token broker (conditional on T0.6 finding refresh conflicts) — M/L
- Depends on: T0.6 (Refuted portability for some provider), T4.13
- Do: for affected providers the VM never refreshes: the local extension (while pi is open) or a
  small scheduled Lambda (Phase 6) refreshes the OAuth token and republishes a short-lived access
  token to Secrets Manager; the in-VM pi is configured with a `pi.registerProvider` shim (bundled in-VM
  extension) that reads the current access token from the secret/env on each request. Falls back to
  "OAuth providers unavailable while pi is closed" with a clear notice if no broker is running.
- Validate: unit tests; integration with a fake OAuth server; live with one affected provider.
- Done when: green; ADR-5 updated.

### T5.8 — Docs and release (G5 part 2) — M
- Depends on: T5.7, T4.10
- Do: `README.md` for users (install, required creds + IAM policy, `npx pi-cloud-agents setup
  --verify` and `/cloud setup` quickstarts, commands, costs, limits incl. 8 h and ARM64, provider
  sync and OAuth notice, troubleshooting), `CHANGELOG.md`, `npm publish --dry-run`, version
  scheme (package version ↔ image `runnerVersion`), demo GIF; fresh-machine install test
  (`pi install npm:pi-cloud-agents@x` in a clean profile) for both the CLI and TUI setup paths.
- Validate: `npm pack` contents check; install test evidence; docs lint.
- Done when: T5.8 validation passes; then run gate G5.

### G5 — Gate: security review + release — S
- Depends on: T5.7, T5.8
- Checklist: `security` CI job green; threat model and IAM docs reviewed; fresh-machine install
  test evidence; `CHANGELOG.md` for v0.1.0; all Phase 5 evidence files present; STATUS.md shows
  every MVP task `done`.
- Passed when: owner marks `G5 passed`; v0.1.0 is published (npm) and tagged.

---

## Phase 6 — Backlog (post-MVP, unscheduled)

| Id | Item | Notes |
|---|---|---|
| T6.1 | Per-repo environment builds (`/cloud build`): image version with deps pre-installed from `.pi/cloud-agents.json`; launch picks it | Cursor "Builds" analogue; big start-time win |
| T6.2 | Hybrid mode: local pi brain, cloud tools via pluggable tool operations over the runner API | reuse `ssh.ts` pattern |
| T6.3 | Team mode: shared stack, per-user prefixes/roles, IAM Identity Center guidance | needs API layer or fine IAM |
| T6.4 | Triggers: GitHub webhook / issue comment → launch (API Gateway + Lambda), Slack | control-plane service |
| T6.5 | Web viewer (static, presigned S3) and mobile-friendly status | |
| T6.6 | Multiple images/pools (toolchains: Python/Rust/JVM) and per-run memory selection | |
| T6.7 | Docker-in-VM support (`AdditionalOsCapabilities: ALL`, DNS notes) | platform quirks documented |
| T6.8 | Per-run scoped AWS credentials (STS session policy) instead of the shared execution role | hardening |

---

## Dependency overview

```
T0.1 → T0.2 → T0.3 → T0.4 ─┐        T0.1 → T0.6 ─┐
               └──→ T0.5 ───┴──────────────────────┴→ G0 → T1.1 → T1.2, T1.3 ; T1.1+T0.6 → T1.4
T1.1 → T2.1 ; T2.1+T1.4 → T2.2 → T2.3, T2.4, T2.6
T2.4 + T1.3 → T2.5a → T2.5b
T2.5a + T2.6 (+ADR-4) → T2.7
T2.3 + T2.5b + T2.7 + T2.10 → T2.8 → G2 → T2.9
T1.1 → T3.1a → T3.1b → T3.2 → T3.3 (needs T2.9)   T1.2 → T3.4   T2.6+T3.1b → T3.5   → G3
T2.5a+T2.6 → T2.10
G2 → T4.1a → T4.1b ; T1.2 → T4.2 ; T4.1a+T4.1b+T4.2+T3.4 → T4.3a → T4.3b (T3.2,T3.3) → T4.3c ; T4.3b+T4.5+T2.8 → T4.3d
T4.3b+T1.1 → T4.4 ; T1.4+T3.4+T4.2 → T4.13
T2.5b + T4.2 → T4.5 ; T4.5+T2.6+T2.10+T4.1b → T4.6 → T4.7a → T4.7b, T4.7c ; T4.7a+T4.5 → T4.7d ; T4.5 → T4.8, T4.12
T4.6+T4.5+T2.10+T4.1b → T4.14 ; T4.3a+T4.3b+T4.3d+T4.1b → T4.15
T4.4+T4.6+T4.8 → T4.9 ; T4.3b+T3.3 → T4.10 ; T4.1a+T4.1b+T1.2 → T4.11 → G4
G4 → T5.1, T5.2, T5.3, T5.5 ; T4.6 → T5.4 ; T4.8 → T5.6 ; T0.6+T4.13 → T5.9 (conditional)
T5.1+T5.2+T5.4+T5.6 → T5.7 → T5.8 → G5
```

Parallel lanes after G0: **Runner lane** (Phase 2), **Infra lane** (T3.1a/b, T3.4, T3.5 up to
G3), **Extension lane** (T4.1a, T4.1b, T4.2 skeletons). Keep one writer per lane/worktree.
