# Protocol Specification (v1)

This document defines the communication contracts, data payloads, state transitions, and error
models used between the pi local extension/CLI, AWS Lambda MicroVM lifecycle hooks, and the in-VM
runner service.

## 1. Overview

The pi-cloud-agents protocol operates across three main communication boundaries:

1. **MicroVM Launch Payload**: Encoded JSON passed via `runHookPayload` to the `/run` lifecycle hook on port 9000.
2. **Run Manifest**: Persistent state document stored at `runs/<runId>/manifest.json` in the user's S3 bucket.
3. **Runner HTTP & Streaming API**: In-VM HTTP/SSE/WebSocket service listening on port 8080.

All JSON schemas are versioned (`v: 1`) and generated directly from Zod definitions into `docs/schemas/`.

## 2. LaunchPayload (v1)

JSON Schema: [`docs/schemas/launch-payload.v1.json`](schemas/launch-payload.v1.json)

The `LaunchPayload` is constructed locally by the launch command (`/cloud new`) and delivered to the MicroVM via the AWS Lambda MicroVM `RunMicrovm` API.

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

## 3. RunManifest (v1)

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

## 4. RunnerStatus (v1)

JSON Schema: [`docs/schemas/runner-status.v1.json`](schemas/runner-status.v1.json)

Exposed by `GET /v1/status` on port 8080.

### Schema Fields
| Field | Type | Description |
|---|---|---|
| `status` | `string` | Overall runner status. |
| `runId` | `string` | Active run identifier. |
| `uptimeSeconds` | `number` | MicroVM runtime uptime in seconds. |
| `activeConnections` | `number` | Count of attached SSE/WebSocket clients. |
| `lastActivityAt` | `string` (ISO) | Timestamp of last user or agent activity. |
| `pi` | `object` | Status of the in-VM pi process (`running`, `pid?`, `currentSessionId?`, `lastEventAt?`). |

## 5. Event Stream & Error Responses

### Server-Sent Events (SSE) Envelope
Streams delivered over `GET /v1/events` format events using the standard envelope:
```json
{
  "id": "entry-0195a1bc-...",
  "type": "message_update",
  "data": { ... }
}
```

### Error Response Envelope
JSON Schema: [`docs/schemas/error-response.v1.json`](schemas/error-response.v1.json)

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

### Protocol Error Codes
| Code | Meaning |
|---|---|
| `INVALID_PAYLOAD` | Schema validation failed on input payload or request body. |
| `PAYLOAD_TOO_LARGE` | Launch payload exceeds 3.5 KB size budget. |
| `UNSUPPORTED_VERSION` | Payload version is not supported (only `v: 1` supported). |
| `SECRET_MISSING` | Required secret is missing from AWS Secrets Manager. |
| `INSTALL_TIMEOUT` | Repository setup/install script exceeded timeout. |
| `PI_PROCESS_CRASH` | In-VM pi RPC process terminated unexpectedly. |
| `UNAUTHORIZED` | Invalid or expired proxy authentication token. |
| `NOT_FOUND` | Requested run, session, or entry was not found. |
| `CONFLICT` | Concurrent conflicting operation or state transition. |
| `INTERNAL_ERROR` | Unhandled internal runner error. |
