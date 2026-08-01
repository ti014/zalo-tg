# Zalo–Telegram Bridge Product Overview

## Purpose

`zalo-tg` bridges one Zalo account with one configured Telegram supergroup.
Each Zalo direct conversation or group is represented by a dedicated Telegram
Forum Topic, so operators and trusted group members can work with Zalo
conversations from Telegram while preserving their context.

## Supported behavior

- Relay text and supported media in both directions.
- Create and maintain a mapping between Zalo conversations and Telegram Forum
  Topics.
- Synchronize replies, mentions, reactions, recalls, contacts, locations,
  polls, and selected Zalo group events where the provider APIs support them.
- Resolve contact aliases before provider display names, keep names scoped per
  group, synchronize group renames, and preserve rich-text object messages.
- Preserve Telegram media quality by keeping static stickers as WebP, keeping
  valid GIFs unchanged, and sending MP4 animations/video stickers through
  Zalo's video path when supported. TGS and definitive provider fallbacks use
  a size-aware, palette-optimized GIF quality ladder.
- Prefer Zalo photo variants in HD, normal, thumbnail order; preserve Unicode
  filenames; render animated Zalo sticker sprite sheets as GIF; and fall back
  from Telegram animation to video and document only after definitive rejects.
- Authenticate the Zalo account using a QR code initiated by the Telegram
  `/login`, `/loginweb`, or `/loginapp` command. PC-App login can recover full
  member data hidden from the Web API.
- Support group history backfill, opt-in delayed DM auto-reply with durable
  cooldown reservations, friend-request pagination, group join review, group
  information, seed inspection, and owner diagnostics.
- Persist mappings, delivery attempts, receipts, media metadata, and
  compatibility state in SQLite.
- Preserve FIFO delivery order within an individual conversation and expose
  uncertain or queued work through `/queue`.

Example: the first incoming message from Zalo group `Project A` creates or
reuses its Telegram Forum Topic. A reply sent in that topic is relayed to the
same Zalo group and retains reply context when the corresponding mapping is
available.

## Delivery contract

The bridge provides at-least-once delivery, not exactly-once delivery. A
provider request may be accepted before the process can persist its receipt;
after a crash, such work is retained as `UNKNOWN` for operator review instead
of being automatically replayed and potentially duplicated.

The delivery lifecycle is `READY`, `SENDING`, `RETRY`, `SENT`, `SKIPPED`,
`UNKNOWN`, or `PERMANENT_FAILED`. The detailed operational response is defined
in [the runbook](../operations.md).

Media fallback must not run after an ambiguous provider outcome: the delivery
remains `UNKNOWN` so an operator can reconcile it without creating a duplicate.
Local Bot API file-URI retries are further limited to definitive HTTP 400
errors that identify the local file path or URL.

## Access and operational boundaries

- `TG_GROUP_ID` selects the only Telegram supergroup served by the bridge.
- `TG_OWNER_IDS` restricts privileged commands such as login, backup, restore,
  queue inspection, and mapping administration.
- Ordinary group members may relay messages; the Telegram group must therefore
  remain private and limited to trusted people.
- The bridge is a single-instance deployment. Two instances must not share one
  SQLite data volume.
- `/restart` is available only when the runtime explicitly declares a process
  supervisor. Production Compose enables it and performs graceful shutdown
  before Docker starts the replacement process.
- Local Telegram Bot API mode is opt-in. It uses a dedicated shared media
  volume and never mounts the SQLite/Zalo credential volume into the Bot API
  container.
- Zalo and Telegram API availability, message-type support, and provider-side
  limits constrain what can be synchronized.

## Persistent data and recovery

The production Docker service stores SQLite, Zalo credentials, compatibility
files, and durable media in an external named volume. Backup artifacts contain
credentials and must be handled as secrets. Restore targets a new volume and
requires verification before a deliberate cutover.

## Source of truth

- [Root README](../../README.md): installation, configuration, commands, and
  architecture overview.
- [Operations runbook](../operations.md): deployment, health acceptance,
  queue handling, backup, restore, and incident recovery.
- `src/`: executable implementation.
- `tests/`: executable proof for configuration, storage, durable delivery,
  authorization, and runtime behavior.

When the bridge's expected user-visible behavior changes, update this document
and the relevant executable tests in the same change.
