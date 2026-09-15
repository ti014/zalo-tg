# Execution Plan: Prevent replay conflict crash loop

Date: 2026-09-15

## Status

Completed

## Outcome

Stop harmless Zalo history replays from terminating the bridge while preserving strict rejection of genuinely conflicting events, then deploy and verify the rebuilt Docker service.

## Context

Runtime inspection found 1,942 Docker restarts. The retained log shows repeated `Idempotency conflict` errors during Zalo `old_messages` replay; `DurableZaloRelay.enqueue` escalates these to process shutdown and Compose restarts the service. `docs/product/overview.md` requires at-least-once delivery and FIFO per conversation.

## Scope

In scope:

- Normalize safe-equivalence comparison for duplicate Zalo replay payloads.
- Add regression proof for the confirmed replay shape.
- Build, deploy, and verify the bridge using its existing external named volume.

Out of scope:

- Deleting or rewriting existing durable events.
- Automatically retrying `UNKNOWN` deliveries.
- Changing provider credentials or broad delivery policy.

## Approach

1. Inspect provider message construction and stored conflict shape without exposing message content.
2. Implement the smallest comparison that ignores provider-only variance but retains routing and delivery-relevant fields.
3. Run focused and repository-wide validation.
4. Build, replace the bridge container while retaining `zalo-tg-data`, then verify readiness, queue status, and restart stability.

## Risks And Recovery

- Over-broad deduplication could hide a real changed event; protect content, sender, destination, timestamp, message type, quote and mentions in the comparison and test rejection of a changed message.
- Deployment failure: Compose retains the external named volume. Restore the prior image by retagging its inspected image ID, then recreate only the bridge container.

## Progress

- [x] Confirm crash-loop cause from Docker runtime evidence.
- [x] Inspect replay payload variance: stored conflicts carry Zalo transport/status fields beyond relay-visible message data.
- [x] Implement and validate strict safe equivalence.
- [x] Deploy rebuilt bridge and observe stability.

## Decisions

- 2026-09-15: Treat payload serialization key order and non-semantic provider fields as replay variance, but preserve all relay-visible message semantics when comparing a duplicate identity.

## Validation

- Focused proof: durable Zalo replay-equivalence tests.
- Repository-required checks: TypeScript build and full test suite.
- Runtime proof: Compose readiness, health, queue audit, no repeated restarts after deployment.

## Result

The Zalo replay comparator now serializes only relay-visible fields in a
deterministic key order, ignoring transport/status metadata and late aliases.
It retains strict comparison for content, routing, sender, timestamp, quote,
mentions, and text formatting. Focused proof plus the repository suite passed
(172 tests), as did the TypeScript build and Docker image build.

The recreated bridge passed readiness and remained healthy with
`restartCount=0`; its new-container logs contain zero idempotency conflicts,
fatal Zalo delivery errors, and Zalo disconnects. The external
`zalo-tg-data` volume was retained. Eighty `READY` Zalo-to-Telegram deliveries
remain intentionally blocked behind two existing `UNKNOWN` deliveries in
separate conversations (`ETIMEDOUT` and `ECONNRESET`); operator reconciliation
through `/queue` is required before FIFO can resume there.
