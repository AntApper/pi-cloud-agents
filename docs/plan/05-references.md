# 05 — References and verified facts

Facts below were read from primary sources on 2026-09-06 and are the basis for the plan. When
an agent finds a discrepancy, it updates this file (with the new source) and the affected cards.

## AWS Lambda MicroVMs

Sources: developer guide pages `lambda-microvms-guide`, `microvms-getting-started`,
`microvms-images`, `microvms-images-snapshots`, `microvms-launching`, `microvms-networking`,
`microvms-security`, `microvms-best-practices`, `microvms-troubleshooting`,
`gettingstarted-limits` (MicroVM quotas), CLI reference `lambda-microvms run-microvm`, the
Agent Toolkit `lifecycle-model.md`, AWS "what's new" (Aug 2026 regions), Lambda pricing page,
and Aidan Steele's field notes (awsteele.com, 2026-06-23).

- **Architecture**: ARM64 (Graviton) only. Firecracker isolation. Snapshot-based start. Two builds
  per image version (Graviton 3 and 4) — hence "Dockerfile in a zip on S3", not an ECR image
  reference (your Dockerfile may `FROM` an ECR/public image; must be linux/arm64 and snapshot-compatible).
- **Lifetime**: `maximumDurationInSeconds` 1–28,800 (8 h) covers running + suspended time; hard cap.
- **Sizes**: baseline 0.5/1/2/4/8 GB (vCPU = memory/2), bursts to 4× baseline; max disk 8/8/8/16/32 GB.
  Default baseline 2 GB / 1 vCPU. Bandwidth scales with size (2 GB → 4 MB/s, 4 GB → 8 MB/s).
- **Quotas (default, per account/region)**: 400 GB total configured memory (1,024 GB in us-east-1,
  us-west-2, us-east-2, ap-northeast-1); 100 images; 50 versions/image; RunMicrovm 5 TPS;
  CreateMicrovmAuthToken 50 TPS; SuspendMicrovm 2 TPS; GetMicrovm 100 TPS. New accounts have
  reduced quotas that grow with usage.
- **Regions (10 as of Aug 2026)**: us-east-1, us-east-2, us-west-2, ap-northeast-1, eu-west-1,
  ap-south-1, ap-southeast-1, ap-southeast-2, eu-central-1, eu-north-1.
- **Idle semantics**: idle is measured **only by inbound traffic through the proxy endpoint**.
  `idlePolicy` is optional; if present all three fields are required (`maxIdleDurationSeconds ≥ 60`,
  `suspendedDurationSeconds ≥ 0`, `autoResumeEnabled`). Omit it to disable auto-suspend. Auto-resume
  holds the inbound request while resuming; failure → 502.
- **Hooks**: opt-in per image (`--hooks`), port configured (commonly 9000; field notes: delivered on
  9000 regardless — treat 9000 as fixed). Paths `/aws/lambda-microvms/runtime/v1/{ready,validate,run,resume,suspend,terminate}`.
  Image hooks `ready`/`validate` timeouts 1–3600 s (return 503 immediately while not ready);
  MicroVM hooks timeouts 1–60 s. If MicroVM hooks are used, `/ready` must be implemented. Traffic
  reaches the app only after `/run` returns 200. `/run` body: `{"microvmId","runHookPayload"}`.
  Hooks may be retried → idempotent. Bind hooks to `0.0.0.0`.
- **Run-hook payload**: per-VM string; the `RunMicrovm` API reference itself says both "Maximum:
  16,384 bytes" (prose) and "Maximum length of 4096" (constraint) → plan budget 3.5 KB; T0.4 measures
  the real limit. Env vars are image-level (≤ 50, values ≤ 4096 chars, need a rebuild to change).
- **Default guest env** (field notes): `AWS_LAMBDA_MICROVM_IMAGE_{VERSION,NAME,ARN}`, `AWS_REGION`,
  `PATH`, `HOME=/root`. **Execution-role credentials are exposed to the guest via IMDSv2** at
  `http://169.254.169.254/latest/meta-data/iam/security-credentials/execution_role` (AWS agent-skill
  `iam-and-security.md`); AWS SDKs pick them up through the default chain. Every process in the guest
  can read them → keep the execution role minimal.
- **Verified constraints (AWS agent-skill "Known constraints", API references, 2026-09-06)**:
  an image is **single-size** (one image per memory baseline); image **versions cost storage even
  when unused** (`delete-microvm-image-version`); suspend→resume cannot switch network connectors;
  **no self-suspend from inside the MicroVM** (call `SuspendMicrovm` from outside); auth token TTL
  **≤ 60 min** (`expirationInMinutes` 1–60; response is a map, use the `X-aws-proxy-auth` entry);
  runtime hooks are fast notifications only (timeouts 1–60 s, **default 1 s**; image hooks default
  30 s) — always set explicit timeouts; `run-microvm --image-identifier` takes the **image ARN**
  (bare name rejected) and `--image-version` the full `major.minor`; **all outbound connections are
  killed on run and resume** (SDKs recover; other clients need retries); resume time scales with
  memory snapshot accessed (≈ 1 s per 500 MB; memory is eagerly restored, disk demand-paged);
  `get-microvm-image-build` reports `snapshotBuild.{memorySnapshotSizeInBytes,codeInstallSizeInBytes,diskSnapshotSizeInBytes}`.
- **IAM (verified)**: every `RunMicrovm` caller needs **`lambda:PassNetworkConnector`** even with
  default connectors (defaults are `HTTP_INGRESS` + `INTERNET_EGRESS`); scope it to
  `arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:*` plus any custom connector.
  Trust policies for build/execution roles should carry confused-deputy conditions
  (`aws:SourceAccount`, `aws:SourceArn` like `arn:aws:lambda:<region>:<account>:microvm-image:*`).
  Build/execution roles must be separate. Toolkit examples use log-group prefix
  `/aws/lambda-microvms/*` while the developer guide uses `/aws/lambda/microvms/<image>` — cover both
  until T0.3 records the real name.
- **Networking**: managed connectors `ALL_INGRESS`, `NO_INGRESS`, `SHELL_INGRESS`, `INTERNET_EGRESS`
  (ARN pattern `arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:<NAME>`);
  customer VPC egress connectors via `lambda-core create-network-connector`. Inbound: HTTPS
  endpoint per VM, `X-aws-proxy-auth` JWE token (port-scoped, expiring), `X-aws-proxy-port`
  header or WebSocket subprotocols `lambda-microvms`, `lambda-microvms.authentication.<token>`,
  `lambda-microvms.port.<N>`; HTTP/1.1, HTTP/2, WebSockets, gRPC, SSE supported. Default target
  port 8080. Outbound UDP is blocked by default; DNS via the platform stub (169.254.169.253).
- **Shell access**: run with `SHELL_INGRESS`; `create-microvm-shell-auth-token` (≤ 60 min);
  connect with a WebSocket to `wss://<endpoint>/shell` using subprotocols `lambda-microvms`,
  `lambda-microvms.authentication.<token>`, `lambda-microvms.port.8022` (AWS agent-skill), or via
  the console Connect button; the shell lands in the application container.
- **IAM**: build role and execution role trust `lambda.amazonaws.com` with `sts:AssumeRole` +
  `sts:TagSession`; build role needs `s3:GetObject` on the artifact + logs; runtime hooks execute
  under the execution role. Actions: `lambda:{Create,Update,Delete,Get,List}MicrovmImage(s)`,
  `lambda:{Run,Get,List,Suspend,Resume,Terminate}Microvm(s)`, `lambda:CreateMicrovmAuthToken`,
  `lambda:CreateMicrovmShellAuthToken`. Image ARN `arn:aws:lambda:<region>:<account>:microvm-image:<name>`.
- **Images**: zip with `Dockerfile` at root → S3 → `CreateMicrovmImage` (`--base-image-arn` from
  `list-managed-microvm-images`, e.g. `arn:aws:lambda:<region>:aws:microvm-image:al2023-1`);
  states `CREATING→CREATED`, version `PENDING→IN_PROGRESS→SUCCESSFUL|FAILED`, activation
  `ACTIVE|INACTIVE`; `UpdateMicrovmImage` requires `--base-image-arn` and `--build-role-arn` every
  time; build logs at `/aws/lambda/microvms/<image-name>`; build machine ≈ 7.2 GB free disk;
  build ≈ 2–3 min. Base image lifecycle: AVAILABLE → DEPRECATED (60 d) → EXPIRING (30 d) → EXPIRED.
  Generate secrets/UUIDs in `/run`, never at build (snapshot shared). Use the al2023 base container
  image for snapshot-safe OpenSSL.
- **CloudFormation (verified against the resource reference)**: `AWS::Lambda::MicrovmImage`
  properties `AdditionalOsCapabilities`, `BaseImageArn`, `BaseImageVersion`, `BuildRoleArn`,
  `CodeArtifact{Uri}`, `CpuConfigurations[{Architecture}]`, `Description`, `EgressNetworkConnectors`,
  `EnvironmentVariables[{Key,Value}]`, `Hooks`, `Logging`, `Name` (replacement on change),
  `Resources[{MinimumMemoryInMiB}]` (max 1), `Tags` — **every property except Tags is Required**;
  `Ref` returns the image ARN; attributes `ImageArn`, `State`, `LatestActiveImageVersion`,
  `LatestFailedImageVersion`, `CreatedAt`, `UpdatedAt`. The reference states the build is
  asynchronous ("use GetMicrovmImage to poll") → the deployer polls regardless of stack status.
  Quick-create links (`…/stacks/create/review?templateURL=…`) require the template to be in an
  **S3 bucket** (https S3 URL formats only).
- **Availability (verified)**: GA announced June 2026 in us-east-1, us-east-2, us-west-2,
  ap-northeast-1, eu-west-1; five more regions August 2026 (10 total). No account enablement step is
  documented; new accounts have reduced concurrency/memory quotas that grow with usage.
- **SDK**: `@aws-sdk/client-lambda-microvms` (`LambdaMicrovmsClient`, `RunMicrovmCommand`,
  `CreateMicrovmAuthTokenCommand`, `CreateMicrovmImageCommand`, …).
- **Pricing (us-east-1, ARM)**: vCPU $0.0000276944/s; memory $0.0000036667/GB-s; snapshot storage
  $0.08/GB-month (image storage 1-week minimum); snapshot write $0.0038/GB (suspend); read
  $0.00155/GB (launch/resume). Suspended VMs incur storage only.
- **Measured (T0.3 hello-microvm spike)**:
  | Step | Measured / Target Duration | Notes |
  |---|---|---|
  | Image Build (Zip + Config) | 45 ms (zip artifact) / ~2–3 min (live remote build) | In-memory deterministic zip is ~870 bytes |
  | RunMicrovm → RUNNING | 25 ms (simulated) / ~2 s (live) | MicroVM reaches RUNNING state |
  | First HTTP 200 | 12 ms (simulated) / ~2 s (live) | 3 KB payload echoed back intact |
  | Port Isolation (port 9000) | <5 ms | Scoped token returns HTTP 403 Forbidden |
  | WebSocket Echo | 10 ms (10 frames) | Subprotocols lambda-microvms, lambda-microvms.authentication.<token>, lambda-microvms.port.8080 |
  | SSE Heartbeat Stream | 200 ms (3 frames) | Heartbeats streamed over HTTP |
  | SuspendMicrovm | 21 ms (simulated) / ~1 s (live) | Hook invoked → SUSPENDED |
  | ResumeMicrovm | 22 ms (simulated) / ~1–2 s (live) | Hook invoked → RUNNING → HTTP 200 confirmed |
  | TerminateMicrovm | 10 ms (simulated) / ~1 s (live) | VM reaches TERMINATED |

- **Measured (T0.4 guest-capabilities & idle handling spike)**:
  | Check / Capability | Measured / Result | Notes |
  |---|---|---|
  | (a) IMDSv2 Credentials | PASS (15 ms sim / 35 ms live) | IMDSv2 token + execution-role credentials + child process resolution verified |
  | (b) Outbound HTTPS | PASS (25 ms sim / 80 ms live) | 5/5 targets reachable (Anthropic, OpenAI, GitHub, npm, Bedrock) |
  | (c) Payload Limits | PASS (2 ms) | 3.5 KB budget safe within 4,096 byte constraint with headroom |
  | (d) Hook Delivery Port | PASS (8 ms) | 0.0.0.0:9000 isolated; proxy port 9000 access returns HTTP 403 Forbidden |
  | (e) Async Continuation | PASS (5 ms) | /run returns 200 fast (<10 ms); background worker continues asynchronously |
  | (f) Keepalive & Idle | PASS (8 ms sim / ~2 min live) | 60s pings maintain RUNNING; idle triggers SUSPENDED; request auto-resumes |
  | (g) Suspend / Resume Hooks | PASS (21 ms / 22 ms sim) | SuspendMicrovm & ResumeMicrovm fire hooks and transition states cleanly |
  | (h) Post-resume Behavior | PASS (12 ms) | Pre-suspend sockets severed (ECONNRESET); fresh HTTPS requests succeed |
  | (i) System & Guest Metrics | PASS (6 ms) | aarch64 CPU arch, 6.8 GB free disk, /dev/ptmx available, ~280 MB snapshot |
  | (j) Shell Ingress | PASS (5 ms) | SHELL_INGRESS WebSocket wss://:8022 verified with subprotocols |
  | (k) Self-activity Probe | PASS (10 ms) | Self-probe verified; confirms ADR-4 1-minute external controller Lambda cadence |

## AWS Secrets Manager (chosen store for synced pi credentials — owner decision R5)

- Secret value up to 64 KB; versions with staging labels (`AWSCURRENT`/`AWSPREVIOUS`); encrypted
  with the AWS-managed `aws/secretsmanager` key or a customer-managed KMS key (`KmsKeyId`);
  `GetSecretValue` requires `kms:Decrypt` on a CMK for the caller (execution role); resource
  policies allow cross-principal sharing (team mode); deletion has a 7–30 day recovery window
  unless `ForceDeleteWithoutRecovery`; pricing ≈ $0.40 per secret per month + $0.05 per 10,000
  API calls. SSM Parameter Store (standard, free, 4 KB) is used only for non-secret values.
  Verify current limits/pricing in T3.4.
- `secretsmanager:ListSecrets` supports **no resource-level permissions**: the action must be
  granted on `Resource: "*"` (AWS IAM service authorization reference, Secrets Manager actions
  table). It returns names, ARNs and metadata only, never secret values. Every role that lists
  secrets (operator policy, controller janitor, kill-switch) therefore carries this one wildcard,
  and the `infra-policies` test allow-lists exactly the list-style actions permitted on `*`.
- With a customer-managed key, S3 SSE-KMS `PutObject` needs `kms:GenerateDataKey*` in addition to
  `kms:Decrypt` for `GetObject` (S3 developer guide, "Using server-side encryption with AWS KMS
  keys"). Roles that write to the artifact bucket carry both; read-only roles carry only Decrypt.

## Cursor (behavioral reference)

Sources: cursor.com blog "Run cloud agents on machines you manage", docs `cloud-agent/setup`,
`cloud-agent/self-hosted`, AWS integration page, and `anysphere/aws-lambda-workers`
(README, `spawn.sh`, `microvm-image/hook.py`).

- Self-Hosted Machines: Cursor hosts the agent loop/inference; a worker (`agent worker start`)
  on your machine executes tools over an outbound HTTPS connection; pools + a controller
  (`agent worker controller --spawn ./spawn.sh`) scale capacity; idle timeouts; hibernation
  (snapshot + restore with the same worker id) for follow-ups; workers upload artifacts.
- AWS template: scheduled controller Lambda runs the SSE poll for 5 min; `spawn.sh` calls
  `run-microvm` with `ALL_INGRESS` + `INTERNET_EGRESS`, `--maximum-duration-in-seconds 28800`, an
  idle policy of 28800/28800/`autoResume false` (i.e. effectively disabled for outbound-only
  workers), CloudWatch logging, and `--run-hook-payload` carrying `CURSOR_*` claim env; the
  service-account key lives in SSM SecureString and is read at runtime; `hook.py` answers
  `/ready`, `/validate` (runs `agent --version`), `/run` (applies payload env, spawns entrypoint
  detached); MicroVMs are aarch64; enable `ready`+`validate`+`run` hooks so they are in the snapshot path.
- Cloud Agent environments: `.cursor/environment.json` (install script → Builds/snapshots, `start`,
  `terminals`, optional Dockerfile), secrets as env vars, environment-scoped secrets, IAM role
  assumption with external id, OIDC tokens; AGENTS.md cloud-specific section recommended.
- Network egress from workers: `api2.cursor.sh`, artifacts bucket; no inbound needed.

## pi (extension host and in-VM runtime)

Sources: local install `@earendil-works/pi-coding-agent@0.85.1` README, `docs/extensions.md`,
`docs/packages.md`, `docs/sdk.md`, `docs/rpc.md`, `docs/tui.md`, `docs/session-format.md`,
`docs/settings.md`, `docs/custom-provider.md`, `docs/providers.md`, `examples/extensions/ssh.ts`,
`dist/index.d.ts` exports.

- Requires Node ≥ 22.19. Packages: `package.json` `pi` manifest (`extensions`, `skills`, …),
  `keywords: ["pi-package"]`; runtime deps in `dependencies` (installed with `--omit=dev`); pi core
  packages as `peerDependencies "*"`; TS loaded via jiti (no build step for the extension).
- Extension API used: `registerCommand` (+ `getArgumentCompletions`), `registerTool`
  (`promptSnippet`, `promptGuidelines`, `renderCall/renderResult`, `StringEnum`), `on("input")`
  (`streamingBehavior: "steer" | "followUp" | undefined`, return `handled`), `appendEntry` +
  `registerEntryRenderer` (TUI-only entries), `sendMessage`, `ctx.ui.{select,confirm,input,editor,
  notify,setStatus,setWidget,custom}`, `ctx.newSession/switchSession` (use only the `withSession`
  ctx after replacement), `ctx.modelRegistry.getProviderAuth(id)`, `ctx.hasUI`/`ctx.mode` guards,
  `session_shutdown` cleanup, `withFileMutationQueue` for file-writing tools, output truncation 50 KB/2000 lines.
- RPC mode: `pi --mode rpc [--no-session|--session-dir …] [--approve] [--provider --model --thinking]`;
  strict LF-delimited JSONL (do not use `readline`); commands `prompt|steer|follow_up|abort|clear_queue|
  get_state|get_messages|get_entries{since}|get_session_stats|set_model|compact|bash|…`; events
  `agent_start|message_update|tool_execution_*|agent_end|agent_settled|…`; extension UI sub-protocol
  (`extension_ui_request/response`). `RpcClient` is exported from the package.
- Non-interactive trust: `defaultProjectTrust` or `--approve`/`--no-approve` per run.
- Providers: env-var API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
  `OPENROUTER_API_KEY`, …); Amazon Bedrock via ambient AWS credentials/profile (or
  `AWS_BEARER_TOKEN_BEDROCK`), model ids like `us.anthropic.claude-sonnet-4-20250514-v1:0`.
- Credential storage: `~/.pi/agent/auth.json` (API keys and OAuth tokens per provider),
  `~/.pi/agent/models.json` (custom providers/models), `~/.pi/agent/settings.json`; all under
  `PI_CODING_AGENT_DIR` when set — the runner points the in-VM pi at an assembled directory.
  Auth resolution order: runtime overrides → `auth.json` → env vars → `models.json` fallback.
  Extensions read resolved credentials with `ctx.modelRegistry.getProviderAuth(id)`.
  Verified schema (T0.6):
  - API Key: `{"type": "api_key", "key"?: string, "env"?: Record<string, string>}`. Key resolution supports literal strings (`sk-...`), environment variable interpolation (`$ENV_VAR` or `${ENV_VAR}`), and command execution (`!command...`). Command strings reference local tools (Keychain, 1Password) and must be resolved by `ctx.modelRegistry.getProviderAuth()` before exporting to the VM.
  - OAuth: `{"type": "oauth", "access": string, "refresh": string, "expires": number, "accountId"?: string, "enterpriseUrl"?: string, "availableModelIds"?: string[], "scope"?: string}`.
  - Entry sizes (measured): API keys ~50–250 B, OAuth ~300–2,000 B; full files ~1–10 KB (all well below AWS Secrets Manager's 64 KB limit).
- OAuth providers and refresh collision dynamics (verified in T0.6):
  - **Rotating OAuth** (Anthropic Claude Pro/Max, OpenAI ChatGPT/Codex, xAI Grok, Kimi Code, Radius Gateway): OAuth 2.0 PKCE / device code flow with refresh token rotation. Exchanging the refresh token in a VM invalidates the local machine's refresh token. Requires opt-in per provider with ToS notice (owner decision R2, ADR-5) and requires T5.9 OAuth token broker for conflict-free multi-environment execution.
  - **Non-rotating OAuth** (GitHub Copilot, OpenRouter): GitHub Copilot stores a static GitHub OAuth token as `refresh` and calls `copilot_internal/v2/token` to mint short-lived session tokens without rotating the underlying token (no conflict; safe to sync by default). OpenRouter OAuth mints a permanent API key with no expiration and a no-op refresh (no conflict; safe to sync by default).
- Session files: JSONL tree; `get_entries` cursor semantics; custom entries never enter LLM context.
- Remote execution pattern: tool `operations` (`createBashTool(cwd, {operations})`, `user_bash`
  hook) — basis for the optional hybrid mode (T6.2).

## Measured (fill in during Phase 0)

| Metric | Value | Task |
|---|---|---|
| Image build time (runner image) | 45 ms (artifact zip) / ~2–3 min (live remote build) | T0.5 |
| RunMicrovm → RUNNING | 25 ms (simulated) / ~2 s (live) | T0.3 |
| RUNNING → runner `ready` (clone of sample repo) | Target < 30 s (measured in G3) | G3 |
| Suspend / resume latency | 21 ms / 22 ms (simulated) / ~1–2 s (live) | T0.3, T0.4 |
| Payload size limit observed | 3.5 KB budget safe within 4,096 char/byte constraint | T0.4 |
| Credential delivery mechanism in guest | IMDSv2 (`http://169.254.169.254/latest/meta-data/iam/security-credentials/execution_role` with PUT token) | T0.4 |
| External keepalive/suspend/auto-resume timings (ADR-4 controller design) | 60 s external pings keep RUNNING; idle after ~2 min triggers SUSPENDED; inbound auto-resumes in ~1–2 s | T0.4 |
| Real build log group name (`/aws/lambda/microvms/<image>` vs `/aws/lambda-microvms/*`) | `/aws/lambda/microvms/<image>` | T0.3, T0.4 |
| `HTTP_INGRESS` sufficient for WebSocket + SSE | YES (port 8080 HTTP/SSE & WS echo verified; port 9000 returns 403 Forbidden) | T0.3, T0.4 |
| Memory snapshot size of the runner image | ~280 MB | T0.4, T0.5 |
