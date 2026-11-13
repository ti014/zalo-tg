# Execution Plan: Telegram transport recovery

Date: 2026-11-13

## Status

Active

## Outcome

Zalo → Telegram transport resets/timeouts retry automatically with existing FIFO/backoff instead of permanently parking a topic. Build and deploy Docker, then recover four existing transport UNKNOWN deliveries and observe real queue progress.

## Context

- `src/application/durable-zalo.ts`, provider errors, delivery repository and tests.
- `docs/operations.md` durable queue policy; `compose.yaml` production deployment.
- Current production: READY=772, UNKNOWN=4. Thuần Power SENT=218, READY=119.

## Scope

In scope: Zalo → Telegram transport retry classification, safeguards against replay after receipts or unresolved multipart sends, focused tests, docs, Docker deployment and bounded audited recovery.

Out of scope: automatic retry for Telegram → Zalo ambiguous sends, changing unrelated settings, guessing SENT outcomes.

Follow-up authorized by user: send all pending messages, investigate failed media, repair confirmed caption/flood-control failures and retry recoverable terminal deliveries. Do not replace unavailable original files with thumbnails or silently mark failures as sent.

## Approach

1. Verify send transport and existing receipt/multipart protections.
2. Retry network failures without the general max-attempt cutoff, preserving FIFO and capped backoff. Keep partial sends/storage failures UNKNOWN.
3. Run typecheck and focused/full tests against baseline.
4. Preserve old Docker image and SQLite backup; build a distinct runtime image, recreate only bridge with existing environment/volume, verify health.
5. Requeue eligible existing UNKNOWN once through repository API and observe progress. Do not falsely mark SENT.

## Risks And Recovery

- User explicitly selected automatic retry despite possible duplicates on 2026-11-13.
- Receipt/multipart/storage uncertainty remains manual; no automatic discard or fake acceptance.
- Rollback to preserved Docker image using Compose. SQLite schema unchanged; do not restore old database over new messages except explicit disaster recovery.
- Global git-commit skill requires approval of full message before commit/push.

## Progress

- [x] User approved automatic retry for Zalo → Telegram transport failures.
- [x] Implementation and focused tests: typecheck and 41/41 tests pass.
- [x] Full tests compared with baseline: 158/164 pass; same six failures as baseline (154/160).
- [x] Runtime image built: `zalo-tg-bridge:transport-recovery-20261113`, sha256:750ae271c50e83924849d3f732f813927b271d3931a92c964677211a515a4db1. Runtime JS syntax check passed.
- [x] Deploy approved explicitly by user; recreated bridge with new image. Storage/Telegram/Zalo all ready; Docker healthy. One startup restart due to getChatMember ECONNRESET, then successful login.
- [x] Four existing ECONNRESET UNKNOWN rows requeued via repository with operator audit, no receipts or multipart uncertainty. UNKNOWN now 0. Three recovered heads SENT; Thuần Power remains RETRY awaiting worker turn.
- [x] Final recovery deployed as `zalo-tg-bridge:final-recovery-20261114` (sha256:b9e34f44a7a494c45f9dc723af298a57b602d4e3dbb62cab9ab7a009c1bf7e60); storage/Telegram/Zalo ready, Docker healthy, restart count 0.
- [x] Requeued six recoverable terminal deliveries through repository audit: three long captions, flood-control 400, and two non-empty media URLs. Requeued Thuần Power delivery interrupted by final deployment only after proving zero receipts and zero multipart rows.
- [x] Probed unavailable media: 24 original Zalo URLs return HTTP 404, zero zero-byte spool rows. No original content exists to send. New code terminates all-404/410 candidate sets as `MEDIA_UNAVAILABLE` after trying each candidate once, avoiding retry delay and releasing FIFO; final image also sends an explicit text notice for unavailable durable photos.
- [ ] Observe remaining FIFO backlog to terminal delivery; polling read was blocked after latest recovery. Commit/push after full message approval.

Old image preserved as `zalo-tg-bridge:before-transport-recovery-20261113`; SQLite online backup `/app/data/bridge-before-transport-deploy-1794587967996.db`. New image also tagged `zalo-tg-bridge:local` to preserve default Compose behavior. Deployment overlay currently at session scratch `deploy-transport.yaml` sets image and preserves existing `.env` path.

Last observation: SENT 4973 → 5002, READY 772 → 743, RETRY 3, SENDING 1, UNKNOWN 0. Thuần Power SENT 218 / READY 119 / RETRY 1. Existing DLQ=16 and PERMANENT_FAILED=4 unchanged. No runtime transport-reset retry observed yet; executable tests cover that path. Do not claim backlog drained or Thuần Power head sent yet.

## Decisions

- 2026-11-13: Prioritize eventual forwarding and FIFO over avoiding all duplicate sends; do not extend that choice to partial provider receipts or multipart uncertainty.

## Validation

- Network reset/timeout beyond maxAttempts still RETRY; later same-topic messages stay blocked until success.
- Receipt-write failures, existing receipts across attempts and UNKNOWN multipart parts remain UNKNOWN.
- Typecheck, focused delivery tests, full suite baseline comparison, production health and queue counts.

## Result

Pending.
