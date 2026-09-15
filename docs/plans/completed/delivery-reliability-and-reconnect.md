# Delivery reliability and reconnect recovery

## Outcome

Prevent supported user messages from disappearing silently, restore Zalo
connectivity automatically after transient failures, and recover messages that
arrive during a reconnect window when the provider history API can prove them.

## Context

- Runtime evidence on 2026-08-15 showed repeated DNS failures to both Zalo and
  Telegram, repeated Zalo reconnect attempts, and one `UNKNOWN` delivery that
  blocked 150 later `RDP_Family` messages.
- After operator-confirmed retry, that conversation drained completely.
- The global queue still contains 14 Zalo-to-Telegram and 5
  Telegram-to-Zalo `PERMANENT_FAILED` deliveries. Representative causes are
  oversized media, invalid Telegram photo dimensions, overlong poll options,
  incomplete link payloads, and unsupported message types.
- The worktree already contains uncommitted topic-name reconciliation changes.
  This work must preserve and integrate with them.

## Approach

1. Audit listener reconnect semantics, provider history support, durable intake,
   and every current permanent-failure class.
2. Add focused tests that reproduce each confirmed silent-loss path.
3. Implement the smallest safe recovery/fallback behavior without weakening
   durable receipts, FIFO ordering, or `UNKNOWN` reconciliation guarantees.
4. Rebuild and deploy the bridge, verify readiness, queue health, reconnect
   behavior, and observable Telegram delivery receipts.

## Authority and constraints

- `docs/product/overview.md` requires durable capture, at-least-once delivery,
  FIFO per conversation, and operator review for ambiguous provider outcomes.
- Do not auto-retry `UNKNOWN`; that can duplicate accepted provider messages.
- Do not select an external DNS provider without explicit operator authority.
- Preserve all pre-existing uncommitted topic reconciliation work.
- Prefer a visible fallback message over silent permanent failure when the
  original payload cannot be represented safely.

## Risks and recovery

- History backfill can duplicate live events unless it reuses the same durable
  source identity. Validate idempotency before enabling it.
- Media fallback must not run after an ambiguous provider outcome.
- If deployment validation fails, retain the current data volume and rebuild
  the previously running image; no database rows should be deleted.

## Progress

- [x] Recover `RDP_Family` queue and verify all backlog deliveries terminate.
- [x] Audit global durable queue and enumerate current permanent-failure classes.
- [x] Audit reconnect and provider history behavior.
- [x] Add regression tests and implement reliability fixes.
- [x] Run focused and repository-wide validation.
- [x] Deploy and verify runtime behavior.

## Decisions

- 2026-08-15: Keep `UNKNOWN` as an operator decision. The observed
  `RDP_Family` timeout was retried only after the user confirmed absence and it
  had no provider receipt.
- 2026-08-15: Do not reset all mappings; current routing is healthy and the
  outage was caused by queue/reconnect behavior, not a missing topic.
- 2026-08-15: Treat Telegram `forum_topic_edited` updates as audited skips;
  runtime evidence showed all five historical `UNSUPPORTED_MESSAGE` failures
  were service events rather than user content.
- 2026-08-15: Raise this deployment's `MEDIA_MAX_OBJECT_MB` override to 1024
  after verifying about 924 GiB free data storage, 1 GiB tmpfs, 45 MiB chunks,
  and receipt-resumable multipart delivery.

## Result

- Zalo readiness now waits for the actual listener `connected` event. Initial
  auto-login failure enters the same capped reconnect loop as later disconnects.
- Successful connections request recent direct/group history replay through the
  durable idempotent intake path.
- Telegram photo-format rejection falls back to document only for definitive
  400 responses; ambiguous timeouts remain `UNKNOWN`.
- Malformed Zalo payloads emit a visible fallback notice, poll options are
  bounded safely, and Telegram forum metadata events become audited skips.
- All 170 repository tests and TypeScript build passed.
- The rebuilt production container passed readiness. All 19 historical
  `PERMANENT_FAILED` rows were requeued: five became `SKIPPED`, fourteen were
  delivered to Telegram, including 242 MiB, 292 MiB, and 927 MiB files split
  into 6, 7, and 20 receipt-tracked parts.
- Final durable queue audit contained no `READY`, `RETRY`, `SENDING`, `UNKNOWN`,
  `PERMANENT_FAILED`, or `DLQ` rows.
