# Execution Plan: Bridge reliability improvements

Date: 2026-11-14

## Status

Completed

## Outcome

Fix the four issues identified in the read-only review, one step at a time, with executable proof after each step. No production deployment or git commit/push without separate approval.

## Context

- User requested a plan followed by step-by-step fixes.
- `docs/WORKFLOW.md` is workflow authority; existing HTML escaping, Zalo request lanes, SQLite queue and Node 24 Docker runtime are reused.
- Current baseline: `fdc2acb`, merged into remote main. Full suite has one reproducible shared-temp test defect.

## Scope

1. Escape untrusted actor names/icons in reaction summary HTML.
2. Bound optional reminder lookups with one total 5-second deadline; use the existing low-priority Zalo lane without retries. Expired queued work must not issue further requests. Keep original e-card text on timeout/failure.
3. Check UNKNOWN alerts independently every 60 seconds, paginate by `(updated_at, id)`, split notices within Telegram text limits, advance cursor only after successful sends, and stop the timer on shutdown.
4. Correct the shared-temp fallback test and add minimal GitHub Actions Node 24 typecheck/test/build workflow with dummy Telegram configuration.

Out of scope: worker concurrency, sending retry policy, SQLite schema changes, production changes, new dependencies, reminder/reaction architecture rewrites.

## Approach

- Write plan first.
- Inspect callers and existing proof for each shared function before changes.
- Implement the smallest complete fix for each numbered step and run focused tests in Node 24 Docker.
- Update this file after each step; then run full suite, TypeScript build and diff checks.
- Move this plan to completed only after validation succeeds.

## Risks And Recovery

- Deadline applies only to optional read-only reminder enrichment, never side-effecting sends. An in-flight ZCA read cannot be forcibly cancelled through its current API; prevent pagination/retries and queued requests after expiry.
- Alerts may repeat after process restart (existing behavior); do not pretend in-memory cursor is durable. Telegram send acknowledgement loss can also duplicate an alert.
- HTML names now render literally; no user-provided markup is interpreted.
- CI uses no production secrets or external chat sends. No dependency added.
- Changes remain in isolated worktree; rollback by reverting only these changes, never reset unrelated work.

## Progress

- [x] Plan written; scope and validation defined.
- [x] Step 1: reaction HTML escaping and regression tests. Existing `escapeHtml` used only at render time; 7/7 reaction tests pass on Node 24, including untrusted icon/name and repeated rendering.
- [x] Step 2: bounded reminder enrichment and timeout/queue tests. One 5-second budget includes low-priority queue wait and all pages; timed-out reads stop pagination, expired queued work makes no API call. Malformed params keep fallback. Typecheck and combined reaction/reminder tests: 10/10 pass.
- [x] Step 3: prompt, bounded UNKNOWN alerts and pagination/send-failure tests. Dedicated 60-second timer starts after Telegram readiness and stops on shutdown. Cursor is `(updated_at, id)`, batches fit 4096 UTF-16 units and only acknowledged chunks advance. Typecheck and related tests: 25/25 pass.
- [x] Step 4: fallback test now injects a throwing UID provider; CI workflow uses Node 24.18.0 with synthetic Telegram environment and read-only GitHub token. Final typecheck, 187/187 tests, writable TypeScript build, actual Docker `build` target and YAML assertions all pass. No dependency added.

## Decisions

- 2026-11-14: User authorized the four fixes after review. Keep existing durable/FIFO/provider-receipt semantics unchanged.
- 2026-11-14: Use a 5-second total optional enrichment budget and 60-second alert interval, fixed small operational defaults rather than adding configuration switches.

## Validation

- Step 1: `<`, `>`, `&` in actor names and fallback icons escape exactly once; counts unchanged.
- Step 2: malformed/absent reminders retain fallback; hung reads return by deadline; no new pagination/queued API call after deadline.
- Step 3: more than 50 UNKNOWN rows at identical timestamp are all visible across pages; alert text <=4096 UTF-16 units; failed send does not lose that batch; no overlapping checks.
- Step 4: fallback test exercises throwing UID/username paths; CI YAML and commands reviewed; full Node 24 suite and build pass.

## Result

All four steps implemented and validated in isolated worktree on 2026-11-14. Full suite is now 187/187 passing, compared with 180/181 at task start. Regression coverage includes the real durable worker progressing to a second conversation after a hung reminder read, HTML rendering, same-timestamp pagination, chunked notifications and send-failure retry.

The first validation build failed because the development container user cannot create `/app/dist`; rerun into writable `/tmp/reliability-dist` passed, then the actual Docker build target (which runs `npm run build`) passed. A supplemental YAML check first used unavailable `js-yaml`; validation then passed using installed host PyYAML without changing project dependencies.

CI syntax and configured commands were validated locally; a hosted GitHub Actions run is not claimed before push. Production was not read or modified; no runtime deploy, commit or push performed. Await user approval for those separate actions. In-flight optional ZCA read cannot be cancelled; alerts use an in-memory cursor and may repeat after restart.
