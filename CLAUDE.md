# CLAUDE.md

This project's agent operating manual is `AGENTS.md` (single source of truth for every coding
agent, regardless of harness). Read it fully before working here.

@AGENTS.md

Quick reminders for tools that do not import the file above:

- Start every session with `docs/plan/STATUS.md`, the last entries of `docs/plan/JOURNAL.md`, then
  your task card in `docs/plan/04-tasks.md`. Mark the task in-progress before starting.
- A task is done only when every item in its "Validate" list passed and `npm run check` is green;
  record outputs in `docs/evidence/<TASK-ID>.md`; append a hand-off entry to `docs/plan/JOURNAL.md`.
- AWS work: kill-switch first, test-prefixed names, `maximumDurationInSeconds` on every VM, cleanup
  verification at the end. Never commit secrets or account ids. No emoji anywhere.
