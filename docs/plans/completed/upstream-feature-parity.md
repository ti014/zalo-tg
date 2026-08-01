# Execution Plan: Upstream Feature Parity

Date: 2026-07-31
Completed: 2026-07-31

## Status

Complete

## Outcome

Bring the current refactored bridge to behavioral parity with user-facing
features added to `williamcachamwri/zalo-tg` after the fork point, while
preserving the current durable SQLite delivery, media, authorization, and
recovery architecture. Every ported behavior must have focused regression
proof and the repository must continue to build and pass its full test suite.

## Context

- Repository workflow: `docs/WORKFLOW.md`.
- Current product behavior: `docs/product/overview.md`, `README.md`, and
  `README.vi.md`.
- Current runtime entry points: `src/index.ts`, `src/telegram/handler.ts`, and
  `src/zalo/handler.ts`.
- Durable delivery boundaries: `src/application/durable-telegram.ts`,
  `src/application/durable-zalo.ts`, and
  `src/infrastructure/database/delivery-repository.ts`.
- Upstream remote: `upstream/main` at `155b6cc`.
- The local historical fork commit `4312bfa` and upstream commit `65c5680`
  have the same tree `c029c5d`, despite rewritten upstream commit IDs. There
  are 189 upstream commits after that equivalent fork point.

## Scope

In scope:

- Inventory every externally observable upstream feature after `65c5680`.
- Mark behavior already present in the refactor and retain its existing proof.
- Reimplement missing Telegram, Zalo, media, command, login, operator, and
  deployment behavior at the appropriate current architecture boundary.
- Add regression tests for each newly ported behavior.
- Update configuration examples and user/operations documentation for the
  resulting behavior.
- Assess and integrate the upstream terminal UI and installer only where they
  remain compatible with the current Docker and persistence contracts.

Out of scope:

- Merging upstream history wholesale or replacing the durable architecture
  with upstream's file-backed stores.
- Reintroducing reverted upstream experiments.
- Copying documentation-only or cosmetic changes that do not describe the
  resulting product.
- Automatically pushing or releasing changes without a separate request.

## Approach

1. Build a parity matrix from the 189 commits, upstream source paths, current
   source paths, and existing tests.
2. Group missing behavior by runtime workflow and dependency order: shared
   contracts/config, Telegram commands and callbacks, Zalo event behavior,
   media conversion and local Bot API, then operator tooling.
3. For each group, trace the upstream entry point, transformations, side
   effects, failure handling, and user-visible result. Port the behavior into
   current layers without bypassing durable intake/delivery.
4. Add focused regression tests before moving to the next group.
5. Run the full build and test suite, update docs, and record remaining
   incompatibilities explicitly.

## Risks And Recovery

- Upstream history was rewritten, so ancestry-based merge tools cannot identify
  parity. Mitigate with the equal-tree fork anchor and behavior-level review.
- Upstream handlers perform some provider calls inline, while the current
  architecture requires durable intake and replay. Keep all relay effects
  behind the existing workers and repositories.
- Login, auto-reply, and operator features introduce security-sensitive policy.
  Preserve upstream opt-in/default behavior and current owner authorization.
- Provider APIs are unofficial and runtime-only behaviors may not be fully
  reproducible in unit tests. Isolate provider contracts and disclose any
  manual verification still required.
- Recover by reverting individual feature commits or disabling newly introduced
  opt-in configuration; do not roll back SQLite migrations destructively.

## Progress

- [x] Fetch `upstream/main` and identify the equal-tree fork anchor.
- [x] Create the initial feature-parity matrix.
- [x] Port missing runtime feature groups with focused tests.
- [x] Integrate compatible operator/deployment features.
- [x] Update product and operations documentation.
- [x] Run focused tests, full tests, and TypeScript build.
- [x] Record results and move this plan to `docs/plans/completed/`.

## Decisions

- 2026-07-31: Use behavior-level porting rather than Git merge/cherry-pick
  because upstream rewrote history and the current architecture has different
  persistence and delivery guarantees.
- 2026-07-31: Treat upstream behavior as product authority for new features,
  while retaining current authorization and durability guarantees where the
  implementations differ.
- 2026-07-31: Keep production album delivery item-by-item through the durable
  FIFO queue instead of restoring an in-memory debounce boundary.
- 2026-07-31: Implement local Telegram Bot API as an opt-in Compose overlay
  with a dedicated shared volume. Use file URIs only inside that root and retry
  multipart only for definitive HTTP 400 local-file rejections.
- 2026-07-31: Make `/update` a read-only GitHub comparison against the audited
  upstream baseline and make `/restart` conditional on an explicit supervisor.
- 2026-07-31: Do not port the Go TUI or mutable shell installer because they
  conflict with the maintained read-only Docker, SQLite recovery, and
  PowerShell operations contracts. Record the lasting boundary in
  `docs/decisions/0001-upstream-feature-port-boundaries.md`.

### Feature-parity matrix (final)

| Upstream behavior | Anchor | Current status | Port target |
| --- | --- | --- | --- |
| Rich text styles, grapheme-safe formatting, link-only fallback | `2517992` | Done | `utils/format`, Zalo message pipeline |
| Reaction target fallback, native DM reactions, catch-up dedupe | `402d455`, later fixes | Done | Zalo event layer and reaction stores |
| Typing/seen indicators | `594a187` | Done | Zalo event layer |
| Recall by Telegram reaction and mapped incoming messages | `e4d635d` | Done | recall application service and reaction event |
| Muted-thread silent forwarding | `c3dbf30` | Done | opt-out `ZALO_MUTE_SILENT` policy |
| Username search fallback | `a99910f` | Done | modular `/search` command |
| Group info/full member view and hidden-member detection | `9f6791a`, later | Done | App API adapter, warmup, group commands |
| PC App QR login, app session and backup dkey | `9609d75`, `781a866` | Done | Web/App login services and `/seed` |
| Group history backfill | `1b7c8d1` | Done | replay is enqueued through the durable relay |
| Offline DM auto-reply | `1b7c8d1` | Done | opt-in service with persisted cooldown reservation |
| Join requests, admin approval/rejection and chat delete/card/call events | later May commits | Done | event/message layers and callbacks |
| Local Telegram Bot API and shared temp paths | `cc50e35`, `efc9687` | Done | path-scoped file handling and Compose overlay |
| Friend-request pagination/revoke, admin panel, seed/status extensions | May commits | Done | modular commands and callbacks |
| Contact names, group rename, reply/chunk safety, album message aliases | May fixes | Done | current stores, domain rules, event/message layers |
| Animated media, photo candidates, Unicode filenames | `e37a723`, `9baf3f5`, `85be4e4` | Done | durable media and Telegram fallback adapters |
| Supervised restart | `580fa3c`, later | Done | graceful current lifecycle, Compose-only enablement |
| TUI sidecar and installer | July commits | Assessed, not integrated | incompatible with current deployment authority |

## Validation

- `npm run build`: passed.
- `npm test`: passed, 153/153 tests.
- `docker compose config --quiet`: passed.
- Local Bot API overlay config with placeholder API credentials: passed.
- Live read-only GitHub upstream check: returned `current` for `155b6cc`.
- `git diff --check`: passed; only expected Windows autocrlf notices appeared.
- Live Telegram/Zalo provider and 2 GB transfer smoke tests were not run because
  they require real bot API credentials, account sessions, and external state.

## Result

Behavior from upstream through `155b6cc` was reviewed and either ported with
regression proof or explicitly rejected where it conflicts with the current
architecture. The implementation preserves SQLite durable delivery, FIFO,
provider receipts, authorization, media spool, and recovery. The remaining
operational risk is live-provider verification of the opt-in local Bot API and
unofficial Zalo endpoints; no unverified end-to-end claim is made.
