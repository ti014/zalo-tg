# Execution Plan: Reliable Zalo Group Topic Names

Date: 2026-08-10

## Status

Completed

## Outcome

Group topics are always routed by stable Zalo identifiers, never acquire a
member's name when group metadata is unavailable, and converge to the current
authoritative Zalo group name after login or a rename event.

## Context

- `src/zalo/message-handler.ts` previously fell back from missing group info to
  the sender name.
- `src/zalo/topic.ts` previously only replaced numeric group-name placeholders,
  so an incorrect human name could remain indefinitely.
- `src/zalo/event-handlers.ts` already applies observed group rename events.
- `src/store/topics.ts` and SQLite `topic_links` persist mappings by Telegram
  chat, Telegram topic, Zalo thread, and thread type.
- Production SQLite contains both current-chat runtime mappings and isolated
  legacy mappings for an older Telegram chat.

## Scope

In scope:

- Prevent sender names from becoming group topic names.
- Track whether a stored name is authoritative or a placeholder.
- Reconcile current Telegram group mappings against the Zalo group list after
  login, with bounded Telegram updates and durable persistence.
- Repair current wrong names without modifying mappings belonging to an old
  Telegram chat.
- Add migration, focused tests, operational documentation, backup, deployment,
  and runtime validation.

Out of scope:

- Reusing Telegram topic IDs across different Telegram chats.
- Deleting legacy audit rows.
- Changing DM contact-name behavior.
- Treating manually renamed Telegram topic titles as authoritative over Zalo.

## Approach

1. Add durable topic name provenance with backward-compatible hydration.
2. Resolve group names from group info, group-list cache, an existing mapping,
   or a deterministic placeholder; never from a sender.
3. Allow authoritative names to replace placeholders while keeping transient
   failures non-destructive.
4. Reconcile current-chat group mappings from `getAllGroups` after Zalo login,
   update Telegram only where names differ, and persist each successful repair.
5. Preserve the existing rename-event fast path and mark it authoritative.
6. Back up production state, deploy, and verify corrected mappings and runtime
   health.

## Risks And Recovery

- Telegram or Zalo rate limits: use the existing Zalo request scheduler and
  process only changed mapped groups sequentially; reconciliation failure is
  non-fatal.
- A manually customized Telegram topic title may be replaced by the Zalo group
  name. The requested invariant makes Zalo the authority for group names.
- Migration failure: startup transaction rolls back automatically. Restore the
  verified pre-deployment backup and previous image if runtime validation fails.
- Partial reconciliation: each successful topic update is persisted
  independently; rerunning is idempotent.

## Progress

- [x] Diagnose current and legacy `RDP_Family` mappings by chat and Zalo ID.
- [x] Add provenance migration and compatible topic-store model.
- [x] Remove sender fallback and implement reconciliation.
- [x] Add focused and integration tests.
- [x] Update operational documentation.
- [x] Back up, deploy, and validate production.

## Decisions

- 2026-08-10: Zalo group metadata is authoritative for group topic titles;
  Telegram names are presentation, while routing remains ID-based.
- 2026-08-10: Reconciliation only mutates mappings for the configured Telegram
  chat; legacy rows remain isolated and untouched.
- 2026-08-10: Metadata lookup failure must retain an existing name or use a
  deterministic placeholder, never a member name.
- 2026-08-10: Reconciliation runs after login/reconnect and every 30 minutes;
  an invalid `getAllGroups` response preserves all mappings instead of pruning.
- 2026-08-11: Treat Telegram `TOPIC_NOT_MODIFIED` as provider confirmation and
  repair the stale SQLite shadow; production exposed this idempotency case.

## Validation

- Focused proof: group-name resolver, provenance precedence, rename handling,
  reconciliation, and `TOPIC_NOT_MODIFIED` idempotency tests passed.
- Integration proof: migration/hydration persistence and current-chat scoping
  passed.
- Repository-required checks: `npm run build` passed; `npm test` passed 161/161.
  Docker container is healthy, startup completed, reconciliation reported four
  repaired names and zero failures, and production SQLite `quick_check` is OK.

## Result

Implemented and deployed. Migration 8 records durable topic-name provenance;
group message handling no longer uses sender names as group fallbacks;
reconciliation runs after login/reconnect and every 30 minutes. Production
repaired four stale SQLite names, all 19 current group mappings now have
`name_source=group_info`, and `RDP_Family` remains mapped to Telegram topic 1950
through Zalo group ID `227786604995019137`.

Recovery backup:

- `/app/data/backups/bridge-pre-topic-reconcile-2026-08-10T16-46-04-093Z.db`
- Size: 7,966,720 bytes.
- Pre-deployment `quick_check`: OK.
