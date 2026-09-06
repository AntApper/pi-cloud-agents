# Protocol Specification (v1)

This document defines the communication contracts, data payloads, state transitions, and error
models used between the pi local extension/CLI, AWS Lambda MicroVM lifecycle hooks, and the in-VM
runner service.

## 1. Overview

The pi-cloud-agents protocol operates across three main communication boundaries:

1. **MicroVM Lifecycle Hooks**: In-VM HTTP service listening on `0.0.0.0:9000`, invoked exclusively by the AWS Lambda MicroVM control plane (`RunMicrovm`, `SuspendMicrovm`, `ResumeMicrovm`, `TerminateMicrovm`).
2. **Runner HTTP & Streaming API**: In-VM HTTP/SSE/WebSocket service listening on `0.0.0.0:8080`, accessible from the local extension/CLI via the authenticated AWS Lambda MicroVM Proxy.
3. **Run Manifest & State Storage**: Persistent state document stored at `runs/<runId>/manifest.json` in the user's S3 bucket.

All JSON schemas are versioned (`v: 1`) and generated directly from Zod definitions into `docs/schemas/`.

---

## 2. Proxy Authentication & Networking

All client requests to the runner API (port 8080) pass through the AWS Lambda MicroVM HTTPS proxy endpoint (`https://<endpoint>/...`).

### Headers Required
| Header | Value | Description |
|---|---|---|
| `x-aws-proxy-auth` | `string` (JWE token) | JWE auth token minted by `CreateMicrovmAuthToken`. Port-scoped to `8080`. Validity duration <= 60 min (client refreshes at T-5 min). |
| `x-aws-proxy-port` | `8080` | Target port inside the MicroVM. Direct external access to port 9000 is blocked (returns 403 Forbidden). |

### WebSocket Subprotocols
When connecting to WebSocket endpoints over the proxy (`wss://<endpoint>/ws/rpc` or `wss://<endpoint>/shell`), the following subprotocols must be negotiated:
- `lambda-microvms`
- `lambda-microvms.authentication.<token>`
- `lambda-microvms.port.8080` (or `lambda-microvms.port.8022` for the shell daemon)

---

## 3. MicroVM Launch Payload (v1)

JSON Schema: [`docs/schemas/launch-payload.v1.json`](schemas/launch-payload.v1.json)

The `LaunchPayload` is constructed locally by the launch command (`/cloud new`) and delivered to the MicroVM via the AWS Lambda MicroVM `RunMicrovm` API in `runHookPayload`.

### Size Constraints
- **Budget**: Maximum 3,584 bytes (3.5 KB) serialized UTF-8 length.
- Enforced at creation time via `assertPayloadFits()`.
- Carries resource references (S3 keys, Secret names) rather than embedded blobs or tokens.

### Schema Fields
| Field | Type | Description |
|---|---|---|
| `v` | `1` (literal) | Schema version. Must be 1. |
| `runId` | `string` | Unique run identifier matching `^run-[a-z0-9-]+$`. |
| `owner` | `string` | IAM identity or user identifier of the launcher. |
| `stack` | `object` | CloudFormation stack context (`name`, `region`, `bucket`, `prefix?`). |
| `repo` | `object` | Repository configuration (`url`, `ref?`, `workBranch`, `depth?`). |
| `model` | `object` | Selected model (`provider`, `id`, `thinking?`). |
| `piConfig` | `object` | Config bundle key in S3, required `authParams` secret names, and Bedrock role flag. |
| `github` | `object` | GitHub authentication (`mode: "secret", name: string` or `mode: "none"`). |
| `options` | `object` | Execution options (timeouts, idle policies, max duration up to 28,800s). |
| `logGroup` | `string` | CloudWatch log group for runner diagnostics. |

---

## 4. Run Manifest (v1)

JSON Schema: [`docs/schemas/run-manifest.v1.json`](schemas/run-manifest.v1.json)

The `RunManifest` tracks the complete lifecycle, metadata, git state, token usage, and timeline of a cloud run.

### Status Transitions
Allowed states: `launching`, `running`, `idle`, `suspended`, `completed`, `failed`, `terminated`.

```
launching ──> running <───> idle ───> completed
                 │           │
                 │           └───> suspended ───> running
                 │
                 └───> failed / terminated
```

### Schema Fields
| Field | Type | Description |
|---|---|---|
| `v` | `1` (literal) | Schema version. |
| `runId` | `string` | Run identifier matching `^run-[a-z0-9-]+$`. |
| `owner` | `string` | Identity of the run creator. |
| `status` | `RunStatus` | Current lifecycle state. |
| `createdAt` | `string` (ISO) | Timestamp of run creation. |
| `updatedAt` | `string` (ISO) | Timestamp of last manifest update. |
| `microvmId` | `string?` | AWS MicroVM instance identifier once assigned. |
| `endpoint` | `string?` | Public HTTPS endpoint for proxy access. |
| `imageVersion` | `string` | Deployed runner image version. |
| `repo` | `object` | Repository URL, ref, and work branch. |
| `model` | `object` | Provider and model identifier. |
| `lastEntryId` | `string?` | ID of the most recent pi session entry processed. |
| `usage` | `object?` | Aggregated input/output/total tokens and estimated cost in USD. |
| `git` | `object?` | Current work branch, last commit hash, and pull request URL. |
| `error` | `object?` | Structured error information (`code`, `message`, `details?`). |
| `continuedFrom` | `string?` | Parent run ID if this run continues a previous 8-hour session. |
| `timeline` | `array` | Chronological transition history with status, ISO timestamp, and reason. |

---

## 5. MicroVM Lifecycle Hooks (Port 9000)

The in-VM lifecycle hook server listens on `0.0.0.0:9000` and handles invocations from the MicroVM hypervisor:

| Route | Method | Purpose | Contract |
|---|---|---|---|
| `/aws/lambda-microvms/runtime/v1/ready` | `GET` | VM initialization liveness check | Returns 200 when runner server is up and listening on port 8080. |
| `/aws/lambda-microvms/runtime/v1/validate` | `POST` | Pre-flight validation probe | Verifies environment, disk, and credentials. Returns 200. |
| `/aws/lambda-microvms/runtime/v1/run` | `POST` | VM startup and initial payload delivery | Receives `runHookPayload` (`LaunchPayload`). Must respond 200 within 60s (target < 1s) and start bootstrap asynchronously. |
| `/aws/lambda-microvms/runtime/v1/resume` | `POST` | VM resume from suspension | Resumes background timers, re-establishes outbound network pools, returns 200. |
| `/aws/lambda-microvms/runtime/v1/suspend` | `POST` | VM pre-suspension checkpoint | Flushes session state and manifest to S3, pauses timers, returns 200. |
| `/aws/lambda-microvms/runtime/v1/terminate` | `POST` | VM shutdown notification | Final manifest flush, best-effort git push, returns 200 before hypervisor teardown. |

---

## 6. Runner HTTP & Streaming API (Port 8080)

### 6.1 `GET /healthz`
Liveness probe for the runner HTTP service.
- **Response**: `200 OK`
```json
{
  "status": "ok"
}
```

### 6.2 `GET /v1/status`
Returns live runner status, agent state, uptime, active connection count, and last activity timestamp.
- **JSON Schema**: [`docs/schemas/runner-status.v1.json`](schemas/runner-status.v1.json)
- **Response**: `200 OK`
```json
{
  "status": "running",
  "runId": "run-20260906-abc123",
  "uptimeSeconds": 142,
  "activeConnections": 1,
  "lastActivityAt": "2026-09-06T17:15:00.000Z",
  "pi": {
    "running": true,
    "pid": 1234,
    "currentSessionId": "session-xyz",
    "lastEventAt": "2026-09-06T17:15:00.000Z"
  }
}
```

### 6.3 `GET /v1/manifest`
Returns the current `RunManifest` for this run.
- **JSON Schema**: [`docs/schemas/run-manifest.v1.json`](schemas/run-manifest.v1.json)
- **Response**: `200 OK`

### 6.4 `GET /v1/events`
Server-Sent Events (SSE) stream for live agent transcript updates, tool calls, thinking chunks, and state changes.
- **Query Parameter / Header**: `Last-Event-ID: <entryId>` (resumes replay from specified entry ID).
- **SSE Format**:
```
id: entry-0195a1bc-3456-789a-bcde-f0123456789a
event: message_update
data: {"type":"message_update","entry":{"id":"entry-0195a1bc-...","role":"assistant","content":[{"type":"text","text":"Working on it..."}]}}

```

### 6.5 `POST /v1/prompt`
Submits a user prompt, steer instruction, or queued follow-up message to the running pi agent process.
- **JSON Schema**: [`docs/schemas/prompt-request.v1.json`](schemas/prompt-request.v1.json)
- **Request Body**:
```json
{
  "prompt": "Investigate the build error",
  "mode": "prompt",
  "steer": false
}
```
- **Modes**:
  - `prompt`: Standard prompt. If the agent is currently streaming, returns `409 Conflict` (client should steer or follow-up).
  - `steer`: Steers the active LLM turn with immediate direction.
  - `followUp`: Queues message to be processed once the current turn completes.
- **Response**: `200 OK` `{ "status": "accepted", "mode": "prompt" }`

### 6.6 `POST /v1/interrupt` & `POST /v1/abort`
Interrupts active LLM generation or clears pending message queues.
- **JSON Schema**: [`docs/schemas/interrupt-request.v1.json`](schemas/interrupt-request.v1.json)
- **Request Body**:
```json
{
  "reason": "User requested abort"
}
```
- **Response**: `200 OK` `{ "status": "interrupted" }`

### 6.7 `POST /v1/finalize`
Triggers clean shutdown: aborts active loops, commits pending work branch changes, pushes to remote repository if configured, flushes final manifest and transcript to S3, and transitions state to `completed`.
- **JSON Schema**: [`docs/schemas/finalize-request.v1.json`](schemas/finalize-request.v1.json)
- **Request Body**:
```json
{
  "autoPush": true,
  "commitMessage": "pi-cloud-agent: finalized run"
}
```
- **Response**: `200 OK` `{ "status": "finalizing" }`

### 6.8 `GET /v1/entries`
Retrieves historical session entries since a specified entry ID or cursor.
- **Query Parameter**: `since=<entryId>`
- **Response**: `200 OK` Array of JSON session entries

### 6.9 `GET /v1/metrics`
Retrieves detailed runner performance, resource ring buffer, timeline, and agent observability metrics.
- **Response**: `200 OK` Metrics payload

### 6.10 `POST /v1/checkpoint`
Triggers an immediate flush of the active session transcript and manifest to persistent storage.
- **Response**: `200 OK` `{ "status": "checkpointed" }`

### 6.11 `POST /v1/shutdown`
Initiates graceful runner and agent shutdown.
- **Response**: `200 OK` `{ "status": "shutting_down" }`

---

## 7. WebSocket RPC Passthrough (`/ws/rpc`, `/v1/rpc`)

Provides a low-latency bidirectional channel directly into the in-VM pi process RPC bridge.

### Framing Rules
- **LF-Delimited JSONL (`\n`)**: Each message frame is a UTF-8 string containing exactly one JSON object terminated by `\n`.
- Never use `readline` on streaming sockets (to avoid incorrect line splits on `\u2028` / `\u2029`).
- Frame payloads mirror pi RPC protocol:
  - Client -> VM: `prompt`, `steer`, `follow_up`, `clear_queue`, `abort`, `get_entries`, `extension_ui_response`.
  - VM -> Client: `message_update`, `tool_execution_start`, `tool_execution_end`, `error`, `extension_ui_request`.

---

## 8. Error Responses & Codes

All HTTP error responses return a structured error body:
- **JSON Schema**: [`docs/schemas/error-response.v1.json`](schemas/error-response.v1.json)

```json
{
  "error": {
    "code": "PAYLOAD_TOO_LARGE",
    "message": "LaunchPayload size (4120 bytes) exceeds maximum allowable budget of 3584 bytes",
    "details": {
      "maxBytes": 3584,
      "actualBytes": 4120
    }
  }
}
```

### Standard Protocol Error Codes
| Code | HTTP Status | Meaning |
|---|---|---|
| `INVALID_PAYLOAD` | 400 | Schema validation failed on input payload or request body. |
| `PAYLOAD_TOO_LARGE` | 400 | Launch payload exceeds 3.5 KB size budget. |
| `UNSUPPORTED_VERSION` | 400 | Payload version is not supported (only `v: 1` supported). |
| `UNAUTHORIZED` | 401 | Missing, invalid, or expired proxy authentication token. |
| `NOT_FOUND` | 404 | Requested run, session, or entry was not found. |
| `CONFLICT` | 409 | Concurrent conflicting operation (e.g. prompt while streaming). |
| `SECRET_MISSING` | 500 | Required secret is missing from AWS Secrets Manager. |
| `INSTALL_TIMEOUT` | 500 | Repository setup/install script exceeded timeout. |
| `PI_PROCESS_CRASH` | 500 | In-VM pi RPC process terminated unexpectedly. |
| `INTERNAL_ERROR` | 500 | Unhandled internal runner error. |

---

## 9. Local & Repo Configuration Schemas

- Local configuration (`~/.pi/agent/pi-cloud-agents.json`): [`docs/schemas/local-config.v1.json`](schemas/local-config.v1.json)
- Per-repository configuration (`.pi/cloud-agents.json`): [`docs/schemas/repo-config.v1.json`](schemas/repo-config.v1.json)
