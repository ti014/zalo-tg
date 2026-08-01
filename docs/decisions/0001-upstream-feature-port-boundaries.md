# 0001 Upstream Feature Port Boundaries

Date: 2026-07-31

## Status

Accepted

## Context

The repository is a refactored fork of `williamcachamwri/zalo-tg`. Upstream
added user-facing behavior after the fork point, but its current implementation
uses file-backed runtime state, mutable source updates, a shell runner, a Go TUI,
and a different Docker contract. This fork uses SQLite durable delivery,
provider receipts, a read-only non-root container, checked recovery, and a
PowerShell production runbook.

Merging or cherry-picking upstream wholesale would silently weaken those
guarantees. Ignoring upstream would leave useful bridge behavior unavailable.

## Decision

Port upstream at the behavior level:

- read each source commit and reproduce its externally observable behavior in
  the corresponding current application, domain, provider, or deployment layer;
- retain SQLite FIFO delivery, retry classification, receipt recording,
  authorization, media spool, and recovery as the controlling architecture;
- require regression proof for each ported behavior;
- keep `/update` read-only and make `/restart` available only through an
  explicitly declared process-supervisor contract;
- provide local Telegram Bot API as an opt-in Compose overlay with a dedicated
  shared media volume, path validation, and narrowly classified multipart
  fallback; and
- do not include the upstream Go TUI or mutable shell installer in the hardened
  runtime.

For example, an upstream Zalo GIF fallback is implemented as
`animation → video → document`, but an ambiguous timeout still stops fallback
and enters the existing durable reconciliation path.

## Alternatives Considered

1. Merge or rebase onto upstream. Rejected because upstream history was
   rewritten and its persistence/lifecycle contracts differ materially.
2. Cherry-pick feature commits. Rejected because handlers and stores no longer
   share compatible architecture boundaries.
3. Add the upstream TUI and installer unchanged. Rejected because this adds a
   second toolchain and mutable checkout path to a container-first, read-only
   deployment without improving bridge behavior or durable recovery.
4. Omit local Bot API support. Rejected because it is useful for large media
   and can be isolated safely behind an explicit overlay.

## Consequences

Positive:

- The fork inherits upstream behavior without giving up durable delivery and
  recovery guarantees.
- Feature differences are intentional, documented, and testable.
- Local Bot API does not gain access to SQLite or Zalo credentials.

Tradeoffs:

- Future upstream commits require behavior review instead of automatic merge.
- Production album delivery remains item-by-item FIFO rather than an in-memory
  grouped Telegram album.
- The optional local Bot API still requires provider credentials and a live
  deployment smoke test outside CI.
- Upstream TUI appearance and one-command shell installation are not inherited.

## Follow-Up

- Keep `docs/plans/completed/upstream-feature-parity.md` as the audited commit
  baseline for the first parity pass.
- Re-run the same behavior-level review when `upstream/main` advances.
