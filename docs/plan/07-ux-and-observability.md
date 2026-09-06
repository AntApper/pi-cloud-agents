# 07 — TUI design, observability, and ease of deployment

Owner requirements (2026-09-06): the front end must look **professionally done — no emojis**;
it must show **analytics/information that proves the cloud runners and VMs are working**
(progress, statistics, usage, speed); and deployment must be **as simple as possible for anyone
who has pi and AWS**. This document is the spec those requirements are validated against
(G4 acceptance, T4.1b lint, T4.14 dashboard, T4.15 quick setup).

## 1. Visual design principles

1. **pi-native.** Use pi-tui components (`SelectList`, `SettingsList`, `DynamicBorder`,
   `BorderedLoader`, `Markdown`, `Text`, `Box`) and the active pi theme (`theme.fg/bg`) only. No
   hard-coded colors. Everything must look like it shipped with pi.
2. **No emoji. Ever.** Not in the TUI, CLI output, logs, notifications, README, or commit
   messages. Enforced by a lint test (see §1.2). Status is conveyed with a small, fixed set of
   typographic glyphs plus theme color.
3. **Quiet, dense, aligned.** Tabular data in real columns (padded with `visibleWidth`),
   right-aligned numbers, consistent units, monospace-friendly. One idea per line. No banners,
   no ASCII art, no exclamation marks.
4. **Width-safe and theme-safe.** Every renderer is tested at 80 and 120 columns; truncation
   uses `truncateToWidth`; nothing exceeds `width`. Components rebuild themed strings on
   `invalidate()` so theme switches work.
5. **Progress you can read.** Long operations show a step list with per-step state, elapsed
   time, and an ETA when known (image build ≈ 2–3 min). Never a bare spinner for > 5 s.
6. **Errors are instructions.** Format: `what failed` → `why (AWS error code)` → `do this next`
   (a command or a link). No stack traces in the TUI (they go to the diagnostics bundle).
7. **Consistent vocabulary.** "run" (a cloud agent run), "VM" (the MicroVM), "attach/detach",
   "suspend/resume", "verify", "setup". Same words in TUI, CLI, docs.

### 1.1 Glyph vocabulary (the only non-ASCII symbols allowed in UI strings)

| Purpose | Glyph | Code point | Notes |
|---|---|---|---|
| running / live | `●` | U+25CF | theme `success` |
| idle / waiting | `○` | U+25CB | theme `muted` |
| suspended | `◌` | U+25CC | theme `dim` |
| provisioning / in progress | `◐ ◓ ◑ ◒` | U+25D0–25D3 | spinner frames, theme `accent` |
| failed / attention | `▲` | U+25B2 | theme `error`/`warning` |
| check passed / failed | `✓` / `✗` | U+2713 / U+2717 | verify lists, gates |
| arrows / flow | `→ ← ↑ ↓` | U+2190–2193 | timelines, key hints |
| separators / rules | `│ ─ ┌ ┐ └ ┘ ├ ┤ ·` | box drawing, U+00B7 | tables, footers |
| sparkline | `▁▂▃▄▅▆▇█` | U+2581–2588 | activity per minute |
| ellipsis | `…` | U+2026 | truncation |

Everything else is ASCII. Forbidden code point ranges (lint): U+1F000–U+1FAFF, U+2600–U+26FF,
U+2700–U+27BF except U+2713 and U+2717, U+2B00–U+2BFF, U+FE0F, U+200D, U+1F1E6–U+1F1FF.
The footer badge is text (`cloud 2 running · 1 idle`), not a cloud symbol.

### 1.2 Enforcement

- `tests/unit/ui-style.test.ts` scans `extension/`, `cli/`, `core/` source and `README.md`,
  `docs/*.md` for forbidden code points → fails `npm run check`.
- All UI strings and tables are produced through `extension/ui/kit.ts` (T4.1b): `glyph.*`,
  `badge(state)`, `table(rows, cols)`, `kv(pairs)`, `duration(ms)`, `bytes(n)`, `money(usd)`,
  `pct(x)`, `sparkline(values)`, `timeline(steps)`, `stepList(steps)`. Direct string-building of
  tables in commands is a review rejection.
- Snapshot tests for every screen at 80/120 cols; a `--theme light` run is part of the G4 review.

## 2. Screens

### 2.1 `/cloud` hub (no arguments)

```
┌ pi cloud agents ──────────────────────────────────────────────── us-east-1 · stack ready ┐
│  New run                 start a cloud agent on this repository                          │
│  Runs (3)                2 running · 1 idle                                              │
│  Dashboard               live VM and agent statistics                                    │
│  Verify                  prove the backend works end to end (last: 2h ago, all passed)   │
│  Config                  defaults, providers, budgets                                    │
│  Help                    commands and docs                                               │
└──────────────────────────────────────────────────────────────── ↑↓ select · enter · esc ─┘
```
If setup has not run: a single item `Set up cloud agents (about 8 minutes)` with a two-line
explanation of what will be created and the estimated monthly cost.

### 2.2 `/cloud list`

Columns: `state` (glyph + word) · `run` (short id) · `repository#branch` · `model` · `activity`
(`streaming`, `bash 12s`, `idle 4m`, `suspended 1h`) · `turns` · `tokens` · `cost` · `elapsed` ·
`last event` (age). Sorted by recency; selection opens the action menu (attach · status ·
dashboard · logs · pr · stop).

### 2.3 `/cloud status <run>` — detail card

```
run 7f3a2c   ● running   us-east-1 · mvm-01234567…   image v12 · 4 GB / 2 vCPU · up 42m
repository  github.com/acme/api#main → pi-cloud/7f3a2c (3 commits, +214 −38 in 9 files)
model       anthropic/claude-sonnet-4-5 · thinking medium · context 31%
activity    tool bash (npm test) 12s · last event 1s ago · client live (rtt 84 ms)

timeline    launch → running 2.1s → run hook 0.4s → secrets 0.6s → clone 6.8s → install 41s → ready 51.9s
turns 14 · tool calls 37 (bash 22, edit 9, read 6) · errors 0 · retries 0 · compactions 0
tokens      in 184k · out 21k · cache read 122k · cost $0.91 · avg first token 1.9s · avg turn 24s
vm          cpu 0.62 load · mem 1.3 / 4.0 GB · disk 2.1 / 16 GB · egress 38 MB
checkpoints last commit 3m ago · pushed 3m ago · session mirrored 20s ago
```

### 2.4 `/cloud dashboard` — live fleet view (overlay, refresh 5 s)

- Header: fleet summary — `running 2 · idle 1 · suspended 0 · today 3h 12m · est. $0.81 · launches 6/6 ok · avg launch→ready 48s · controller 40s ago`.
- One row per active run: state glyph, id, repo, activity, `events/min` sparkline for the last
  30 minutes, tokens, cost, elapsed, last event age.
- Activity feed (last 20 events across runs): `12:04:31 7f3a2c bash npm test (exit 0, 11.8s)`.
- Footer hints: `enter attach · s status · l logs · x stop · r refresh · esc close`.
- If nothing is running, the dashboard shows the last completed runs and the last verify result
  (with timings) so the "is it working?" question always has an answer.

### 2.5 Mirror-session footer (attached)

`cloud 7f3a2c · ● running · bash 12s · turn 14 · 205k tok · $0.91 · ctx 31% · vm 42m · live 1s`
Right side: remote model and thinking level. State changes are announced with `notify`.

### 2.6 Verify / setup progress (TUI and CLI identical layout)

```
✓ AWS identity            arn:aws:iam::…:user/ant (us-east-1)                     0.4s
✓ Region supports MicroVMs base al2023-1 v7                                        0.3s
✓ Core stack              pi-cloud-agents-core UPDATE_COMPLETE                      1.1s
◐ Image                   building version 13 … 1m 48s (typically 2–3 min)
  Secrets                 waiting
  Smoke run               waiting
  Model check             waiting
```
Finished report ends with a one-paragraph verdict: what works, timings, cost of the check.

### 2.7 Every-session footer badge

`cloud 2 running · 1 idle` (theme `muted`; `▲` prefix in `warning` color if any run failed since
last viewed). Updated from a 30 s cached fleet poll only while pi is idle, never blocking.

## 3. Observability: the metrics catalogue

Collected by the runner (T2.10) and exposed in `/v1/status` (summary) and `/v1/metrics`
(full, sampled every 5 s, ring buffer 6 h) plus `metrics` frames on SSE.

| Group | Metric | Source | Shown in |
|---|---|---|---|
| Lifecycle | timestamps: launch, RUNNING, `/run`, secrets, clone, install, ready, first prompt, last activity, suspend/resume events | runner + manifest | status timeline, dashboard, verify |
| Agent | state (streaming / tool `name` + elapsed / idle), turns, tool calls by tool, prompts, errors, retries, compactions, last event age | pi RPC events | list, status, footer, dashboard |
| Model | model, thinking, tokens in/out/cache, cost, context %, time-to-first-token (per turn, avg), turn duration (last, avg) | pi `get_session_stats` + event timing | status, footer, dashboard |
| Workspace | repo, base and work branch, commits, files changed / insertions / deletions (`git diff --shortstat`), install duration, last checkpoint/push | runner git | status |
| VM | microvmId, region, image version, memory baseline, uptime, load (1m), memory used/total, disk used/total on `/work`, egress bytes (`/proc/net/dev`) | `/proc`, payload | status, dashboard |
| Client | connection state (live / reconnecting / suspended), status RTT, token expiry | run client | footer, status |
| Fleet | counts by state, elapsed today, estimated spend today/month, launch success rate, avg launch→ready, controller last-run age | manifests + live `GetMicrovm` + `controller/last-run.json` | hub, dashboard, doctor |
| Verify | per-check durations, smoke-run timings, model check latency | verify engine | verify report, dashboard (last result) |

Rules: metrics are computed from real events, never faked; ages are shown relative (`1s ago`);
costs are labeled "est." when derived from rates; the dashboard shows `last event 1s ago` and a
region/VM id on every run so the user can cross-check in the AWS console.

## 4. Ease of deployment ("anyone with pi and AWS")

Targets (measured in G4 with a first-time user):

- **Time to first cloud run ≤ 15 minutes** from `pi install`, including the 2–3 min image build.
- **Two commands**: `pi install npm:pi-cloud-agents` and `/cloud setup` (or
  `npx pi-cloud-agents setup`). Nothing else to install: no Docker, no AWS CLI, no build step.
- **Quick setup is the default**: one screen — detected AWS profile/region, providers found in
  the local pi, estimated monthly cost, "Create" button. "Custom" reveals the full wizard.
- **Zero required input** when defaults work: profile `default`, region `us-east-1`, all
  configured providers, 4 GB, GitHub token optional (asked once, skippable).
- **Permission preflight with remediation**: before creating anything, probe required actions
  (including `lambda:PassNetworkConnector`); if missing, print the least-privilege
  `OperatorPolicy` JSON, write a one-file CloudFormation template an admin can deploy, offer
  `--create-policy` when the caller may create IAM policies (`pi-cloud-agents iam-policy`), then
  stop cleanly.
- **Always resumable**: re-running setup continues where it stopped; `verify` tells you the
  state at any time; `doctor` is a green/red table.
- **One command to remove everything**: `/cloud destroy` (typed confirmation), leaving no
  resources and no charges.
- **First-run guidance**: after setup, a short "next steps" card: how to start a run, attach,
  what it costs, how to stop. The hub shows `Verify … last: all passed` so confidence is visible.
- **Docs written for a first-time user**: 5-minute quickstart, a "what gets created in my
  account" table, a cost table, a troubleshooting table keyed by the error text shown in the TUI.

## 5. Acceptance checklist (used in T4.1b lint, T4.7c review, G4)

- [ ] `ui-style.test.ts` passes: no forbidden code points anywhere in UI strings, README, docs.
- [ ] All screens in §2 exist and match the layouts (snapshot tests at 80/120 cols, dark + light).
- [ ] Every table/list is built through `ui/kit.ts`; no ad-hoc string tables.
- [ ] Dashboard and status show live `last event` ages, VM id + region, timeline durations, tokens,
      cost, context %, VM cpu/mem/disk — from real data.
- [ ] Footer badge in every session; mirror footer with remote stats.
- [ ] Verify/setup progress uses the step list with durations; the final verdict paragraph reads well.
- [ ] Error messages follow what/why/next; none show a stack trace.
- [ ] First-time-user test: cloud run in ≤ 15 min with only the README; notes captured.
- [ ] Owner reviews recordings of hub, list, status, dashboard, attach, verify and signs off
      "professional, no emoji, I can see it's working."
