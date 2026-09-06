# pi-cloud-agents — implementation plan

Cloud agents for [pi](https://pi.dev), modeled on Cursor Cloud Agents + Cursor Self-Hosted
Machines, running on **AWS Lambda MicroVMs in the user's own AWS account**.

Install target for end users (when built):

```bash
pi install npm:pi-cloud-agents     # or: pi install git:github.com/<owner>/pi-cloud-agents
npx pi-cloud-agents setup --verify  # one-shot backend setup + verification (or /cloud setup inside pi)
pi
/cloud new "Add retry logic to the S3 uploader and open a PR"
/cloud attach <run>                 # rich live mirror; survives closing the laptop
```

The user provides credentials only (AWS profile, their existing pi provider logins, a GitHub
token). The setup engine deploys and verifies every cloud resource (CloudFormation stacks,
MicroVM image, IAM roles, secrets, controller, smoke run) from the TUI or the CLI.
No Docker, no AWS CLI, no servers to run. Any model/provider your local pi supports works in the
cloud, because the cloud VM runs pi with your synced pi configuration.

## Documents

| File | Purpose |
|------|---------|
| [AGENTS.md](AGENTS.md) | **Operating manual for agents** working on this repo: reading order, start/end-of-session rituals, non-negotiable rules, conventions, pi and AWS gotchas, escalation, quality bar (pi loads it automatically; `CLAUDE.md` imports it for other tools) |
| [docs/plan/JOURNAL.md](docs/plan/JOURNAL.md) | Append-only hand-off log so any agent can resume in minutes |
| [docs/plan/01-architecture.md](docs/plan/01-architecture.md) | Product scope, system architecture, data flows, security/threat model, cost model |
| [docs/plan/02-decisions.md](docs/plan/02-decisions.md) | Architecture decision records (ADRs), assumptions, and open questions with recommended defaults |
| [docs/plan/03-agent-workflow.md](docs/plan/03-agent-workflow.md) | How an agent works through the tasks: gate protocol, evidence, rules, escalation |
| [docs/plan/04-tasks.md](docs/plan/04-tasks.md) | **The task breakdown**: bite-size task cards with dependencies and validation gates |
| [docs/plan/05-references.md](docs/plan/05-references.md) | Verified source facts (AWS, Cursor, pi) the plan depends on |
| [docs/plan/06-risks.md](docs/plan/06-risks.md) | Risk register and the plan-solidity checklist for the owner |
| [docs/plan/07-ux-and-observability.md](docs/plan/07-ux-and-observability.md) | TUI design rules (professional, no emoji), screen layouts, the metrics catalogue that proves runs are working, and ease-of-deployment targets |
| [docs/plan/STATUS.md](docs/plan/STATUS.md) | Live task tracker + owner decisions log |

## Status

Planning complete; all owner decisions (Q1–Q11, R1–R5) recorded 2026-09-06; **no open
questions**. Implementation has **not started** by owner request — Phase 0 (spikes) begins on the
owner's go.

Scale: 58 task cards (including 5 de-risking spikes) and 5 gates across Phases 0–5, plus a
Phase 6 backlog.

## Product principles (owner requirements)

- **Looks like part of pi.** pi-tui components and theme only; a fixed typographic glyph set;
  **no emoji anywhere** (build fails on it); aligned tables; errors as what/why/next.
- **Proves it is working.** Live metrics from the runner (timeline, activity, tokens, cost,
  context, VM cpu/mem/disk, last-event age, VM id + region) in `/cloud list`, `/cloud status`,
  `/cloud dashboard`, and the mirror-session footer; `/cloud verify` reports measured timings.
- **Simple for anyone with pi and AWS.** Two commands, quick setup by default, permission
  preflight with a copy-paste policy, resumable, one-command teardown; target: first cloud run in
  under 15 minutes.

## One-paragraph architecture

A pi package with four parts. (1) **Shared core** — AWS operations, the idempotent setup
engine, the verification engine (static checks + smoke run), the run client, and the pi
config-bundle builder; no pi-runtime dependency. (2) **Local extension** (`/cloud …` commands,
`cloud_agent` tool, rich mirror sessions that auto-reattach) and a **CLI** (`npx pi-cloud-agents
setup|verify|…`) on top of the core. (3) **Runner** — a small Node service baked into the
MicroVM image that implements the Lambda lifecycle hooks, assembles the user's synced pi config,
clones the repo, runs `pi --mode rpc` as the agent loop, exposes an HTTP/WebSocket/SSE API, and
mirrors the session + a run manifest to S3. (4) **Infra** — CloudFormation: S3 bucket, IAM
roles (build/execution/operator), CloudWatch logs, the MicroVM image, Secrets Manager secrets,
and a 1-minute scheduled "controller" Lambda that keeps working VMs alive (the platform counts
only inbound traffic as activity), suspends idle ones from outside (a VM cannot suspend itself),
and terminates orphans for cost safety. Each cloud agent run = one Firecracker-isolated MicroVM
that suspends when idle, resumes on follow-up, and is terminated when done.
