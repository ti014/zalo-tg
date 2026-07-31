<a href="README.md"><img src="https://flagcdn.com/20x15/us.png" alt="English" width="20" height="15"> English</a> · <a href="README.vi.md"><img src="https://flagcdn.com/20x15/vn.png" alt="Tiếng Việt" width="20" height="15"> Tiếng Việt</a>

<hr>

# zalo-tg

A bidirectional Zalo–Telegram bridge. Every Zalo direct conversation or group is mapped to a Forum Topic in one Telegram supergroup; messages, media, replies, reactions, recalls, polls, and selected group events are synchronized in both directions.

The bridge runs as one long-lived Node.js process. SQLite and a Docker named volume preserve state, media, mappings, and queued deliveries across restarts, upgrades, and controlled restore operations.

## Key features

- Bidirectional text and media relay with automatic Forum Topic mapping.
- Synchronization of replies, mentions, reactions, recalls, contacts, locations, polls, and selected group events.
- Durable SQLite inbox and delivery queue with FIFO ordering per conversation.
- At-least-once delivery, retry, leases, provider receipts, and operator-visible `UNKNOWN` results.
- Durable media spool with size limits, expiry cleanup, and multipart Telegram uploads.
- QR-based Zalo authentication through Telegram.
- Deployment preflight, SQLite instance lease, liveness, and readiness checks.
- Hardened Docker runtime: non-root user, read-only root filesystem, dropped capabilities, resource limits, and an external named volume.

## Table of contents

- [Tech stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Getting started](#getting-started)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Telegram commands](#telegram-commands)
- [Scripts and testing](#scripts-and-testing)
- [Deployment and operations](#deployment-and-operations)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Project structure](#project-structure)
- [Contributing and license](#contributing-and-license)

## Tech stack

| Area | Technology |
| --- | --- |
| Language | TypeScript, ES2022, strict mode |
| Runtime | Node.js 24 production image; Node.js 18+ for local development |
| Telegram | Telegraf and Bot API long polling |
| Zalo | `zca-js` |
| Persistence | SQLite via `better-sqlite3`, WAL mode, versioned migrations |
| Media | FFmpeg, Chromium/Puppeteer, `image-size`, durable media spool |
| Build | TypeScript compiler and `tsx` |
| Deployment | Docker Compose; legacy systemd unit included |

## Prerequisites

- Node.js 18+ and npm 9+ for local development.
- FFmpeg on `PATH` for voice and media conversion. The production image includes it.
- A Telegram bot created with [@BotFather](https://t.me/BotFather).
- A private Telegram supergroup with Forum Topics enabled. The bot must be an administrator with **Manage Topics**, **Delete Messages**, **Pin Messages**, and reaction access.
- An active Zalo account. Its session is stored in `credentials.json` or the configured credentials path.
- Docker Engine and Docker Compose v2 for the recommended production setup.

## Getting started

### 1. Install dependencies

~~~bash
git clone <repository-url>
cd zalo-tg-refactor
npm ci
~~~

`npm ci` uses the lockfile and installs native dependencies required by `better-sqlite3`.

### 2. Configure the bridge

~~~powershell
Copy-Item .env.example .env
~~~

Set at least these values in `.env`:

~~~dotenv
TG_TOKEN=replace-with-telegram-bot-token
TG_GROUP_ID=-1001234567890
TG_OWNER_IDS=123456789,987654321
~~~

`TG_GROUP_ID` must be a negative supergroup ID. Each `TG_OWNER_IDS` value must be a positive numeric Telegram user ID. Do not commit `.env`, `credentials.json`, SQLite files, or backups.

### 3. Run locally

~~~bash
npm run dev
~~~

This command runs `src/index.ts` with `tsx watch`. On first use, send `/login` in the configured Telegram group and scan the QR code using the Zalo mobile app.

~~~bash
npm run build
npm start
~~~

The second sequence compiles to `dist/` and runs the production entrypoint.

### 4. Run with Docker Compose

~~~powershell
docker volume create zalo-tg-data
docker compose config --quiet
docker compose build --pull bridge
docker compose up -d --no-build bridge
docker compose ps
docker compose logs --tail=200 bridge
~~~

The service does not publish a host port because it uses Telegram long polling. Persistent data is mounted at `/app/data` from external volume `zalo-tg-data`. To import existing repository data into a new volume exactly once:

~~~powershell
npm run docker:seed
~~~

### 5. Verify the deployment

~~~powershell
docker compose exec -T bridge node dist/runtime/healthcheck.js
docker compose exec -T bridge node dist/runtime/healthcheck.js --readiness
~~~

Expected output is `alive` and then `ready`. Also send one test message in each direction before accepting a deployment.

## Architecture

### Runtime flow

~~~text
Telegram update (long polling) ─┐
                                ├─ handlers ─ durable SQLite inbox/queue ─ provider API
Zalo listener event ────────────┘                                  │
                                                                   └─ message/topic mappings
~~~

Startup validates configuration, opens SQLite, applies checksummed migrations, imports legacy JSON where needed, hydrates compatibility stores, recovers stale media downloads, acquires a single-instance lease, and starts durable workers. Telegram permissions are checked before Zalo relay starts. If Zalo is not authenticated, Telegram stays available and the operator can run `/login`.

### Durability and recovery

- SQLite is the recovery source for topic/message links, aliases, settings, delivery attempts, receipts, media objects, and operator actions.
- Delivery states are `READY`, `SENDING`, `RETRY`, `SENT`, `SKIPPED`, `UNKNOWN`, and `PERMANENT_FAILED`.
- The bridge is **at least once**, not exactly once. A request that may have reached a provider before a crash becomes `UNKNOWN` rather than being blindly replayed.
- FIFO ordering is preserved per conversation. Use `/queue` to inspect queued, retrying, and uncertain deliveries.
- Legacy `topics.json`, `settings.json`, and `msg-map.json` are imported and can be atomically rehydrated from SQLite.

### Persistent layout

~~~text
/app/data/
├── bridge.db                 # SQLite database; WAL can add -wal and -shm
├── credentials.json          # Zalo session secret
├── topics.json               # legacy compatibility state
├── settings.json             # legacy compatibility state
├── msg-map.json              # legacy compatibility state
├── media/                    # durable media objects
└── backups/                  # application backup artifacts, if enabled
~~~

The health heartbeat is stored at `/tmp/health/health.json` in production. Readiness requires `storage`, `telegram`, and `zalo` all to be `ready`; Compose's healthcheck tests liveness only.

## Configuration

Copy `.env.example` to `.env`. Invalid required IDs, booleans, numbers, or production paths fail fast at startup.

### Required

| Variable | Description | Example |
| --- | --- | --- |
| `TG_TOKEN` | BotFather token | `123456:replace-me` |
| `TG_GROUP_ID` | Destination supergroup ID; negative | `-1001234567890` |
| `TG_OWNER_IDS` | Privileged user IDs, comma/space separated | `123456789,987654321` |

### Runtime and storage

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATA_DIR` | `./data` locally; `/app/data` in Docker | Root for application state |
| `DATABASE_PATH` | `<DATA_DIR>/bridge.db` | SQLite database; production path must remain inside `DATA_DIR` |
| `ZALO_CREDENTIALS_PATH` | local `credentials.json`; Docker `/app/data/credentials.json` | Zalo session; production path must remain inside `DATA_DIR` |
| `HEALTH_DIR` | `DATA_DIR` | Directory containing `health.json` |
| `BRIDGE_DATA_VOLUME` | `zalo-tg-data` | External Docker volume |
| `BRIDGE_IMAGE` | `zalo-tg-bridge:local` | Docker image reference |
| `BUILD_REVISION` | `local-dirty` | OCI revision label |
| `BUILD_VERSION` | `1.0.0` | OCI version label |

### Limits and feature flags

| Variable | Default | Limit or effect |
| --- | ---: | --- |
| `TG_DOWNLOAD_MAX_MB` | 20 | Maximum 200 MB |
| `TG_UPLOAD_PART_MB` | 45 | Maximum 200 MB |
| `TG_UPLOAD_TIMEOUT_SEC` | 600 | Maximum 3600 seconds |
| `MEDIA_MAX_OBJECT_MB` | 200 | Maximum 2048 MB |
| `MEDIA_SPOOL_MAX_MB` | 5120 | Maximum 102400 MB |
| `DELIVERY_SENT_RETENTION_DAYS` | 90 | Maximum 3650 days |
| `DATA_MIN_FREE_MB` | 512 | Minimum free storage guard |
| `ZALO_SKIP_MUTED_GROUPS` | false | Skip messages from muted groups |
| `ZALO_SKIP_STRANGER_MESSAGES` | false | Skip DMs from non-friends |
| `UPDATE_CHECK_ENABLED` | false in production | Enable update notifications |
| `ALLOW_SECRET_BACKUP` | false | Permit backups containing secrets |
| `TG_API_ROOT` | unset | Optional custom Bot API root; read `docs/operations.md` first |

Boolean values accept `1/true/yes/on` and `0/false/no/off`.

## Telegram commands

| Command | Purpose |
| --- | --- |
| `/login` | Start QR-based Zalo login |
| `/status` | Show bridge and provider status |
| `/topic list\|info\|delete` | Inspect or remove topic mappings |
| `/search <query>` | Search friends and create a direct-message topic |
| `/addfriend`, `/friendrequests` | Manage Zalo friend requests |
| `/addgroup`, `/joingroup`, `/leavegroup` | Manage Zalo groups |
| `/recall` | Recall a bot-originated Zalo message |
| `/queue` | Inspect queue, retry, and `UNKNOWN` deliveries |
| `/backup`, `/restore` | Controlled application backup/restore flows |
| `/settings`, `/members`, `/kick`, `/clear` | Administrative operations |
| `/help`, `/menu` | Show the current command catalog |

Privileged actions are restricted by `TG_OWNER_IDS`. Keep the group private because normal members can still relay messages.

## Scripts and testing

| Command | Description |
| --- | --- |
| `npm run dev` | Run TypeScript with hot reload |
| `npm run build` | Compile `src/` to `dist/` |
| `npm start` | Run compiled bridge |
| `npm test` | Run Node-based TypeScript tests |
| `npm run healthcheck` | Run compiled liveness check |
| `npm run docker:seed` | Seed Docker volume from repository data |
| `npm run tgs:gif` | Convert TGS sticker input to GIF |

Before deployment:

~~~powershell
npm ci
npm run build
npm test
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
git diff --check
~~~

Tests cover configuration, migrations and recovery, legacy import, durable relay flows, media spool behavior, authorization, command registration, health, and provider policies.

## Deployment and operations

Docker Compose is the maintained deployment path. The production container runs as UID/GID 10001 with a read-only root filesystem, no Linux capabilities, `no-new-privileges`, a bounded `/tmp`, a 2 GiB memory limit, and a 2 CPU limit.

~~~powershell
docker compose build --pull --build-arg BUILD_REVISION=$(git rev-parse HEAD) --build-arg BUILD_VERSION=1.0.0 bridge
docker compose up -d --no-build bridge
~~~

Do not run two instances on the same volume. The SQLite lease is a safety net, not supported multi-instance coordination.

For development Compose:

~~~powershell
docker compose -f compose.yaml -f compose.dev.yaml up --build bridge
~~~

It mounts `src/` read-only, uses `npm run dev`, and stores development state in `zalo-tg-dev-data`.

Read [docs/operations.md](docs/operations.md) before production work. It covers token rotation, first deployment, seed/import, queue handling, backup, restore, rollback, and acceptance checks.

~~~powershell
./scripts/backup-docker-volume.ps1 -DryRun
./scripts/backup-docker-volume.ps1
./scripts/restore-docker-volume.ps1 -ArchivePath .\backups\zalo-tg-data-YYYYMMDD-HHMMSS.tgz -DryRun
~~~

Backups include credentials, verify SQLite integrity, and write SHA-256 and manifest files. Restore always targets a new volume, verifies the archive and database, and does not edit `.env` or cut over Compose automatically.

## Troubleshooting

### Startup exits

~~~powershell
docker compose logs --tail=200 bridge
~~~

Check for missing Telegram variables, an invalid group/owner ID, a production database or credentials path outside `DATA_DIR`, missing Telegram administrator permissions, or another instance using the same volume.

### Liveness passes but readiness fails

~~~powershell
docker compose exec -T bridge node dist/runtime/healthcheck.js --readiness
~~~

All components must be ready. `zalo=degraded` usually means Zalo is reconnecting or needs `/login`. Compose does not restart a still-running unhealthy process; use an external supervisor if host-level self-healing is needed.

### A delivery is `UNKNOWN`

Run `/queue` and review its receipts and attempts before retrying. Blind replay can duplicate a message because the provider may already have accepted it.

### Media conversion fails

Check FFmpeg, Chromium, `MEDIA_MAX_OBJECT_MB`, `MEDIA_SPOOL_MAX_MB`, and free space configured by `DATA_MIN_FREE_MB`.

### State appears missing

Confirm the expected named volume is mounted. Never delete the volume as cleanup; restore into a new volume, verify it, then perform a deliberate cutover.

## Security

- Rotate a Telegram token immediately if it appears in a log, diagnostic, screenshot, or chat.
- Do not commit or share `.env`, `credentials.json`, SQLite files, or backup archives.
- Use a private Telegram group limited to trusted members.
- Keep `ALLOW_SECRET_BACKUP=false` unless a documented, access-controlled procedure requires it.
- Treat `credentials.json` as equivalent to a Zalo account password.
- Do not expose a public container port; the bridge uses long polling.

## Project structure

~~~text
src/
├── index.ts                         bootstrap, lifecycle, reconnect, shutdown
├── config.ts                        environment parsing and validation
├── application/                     durable Telegram/Zalo relay and media workflows
├── bootstrap/                       environment and compatibility-store hydration
├── domain/                          IDs, links, retry, provider and topic errors
├── infrastructure/database/         SQLite, migrations, repositories, shadow state
├── infrastructure/files/            atomic file operations
├── infrastructure/media/            durable media spool
├── runtime/                         health, healthcheck, redaction, instance lease
├── store/                           compatibility topic/message/user/poll/settings stores
├── telegram/                        bot, authorization, handlers, commands, UI
├── zalo/                            client, listener, handlers, policies
├── tools/                           Docker seed/verify and TGS conversion
└── utils/                           format, downloads, media, Telegram queue
tests/                               Node-based TypeScript tests
compose*.yaml                        production, development, and seed overlays
Dockerfile                           multi-stage production image
docs/operations.md                   production runbook
scripts/                             PowerShell backup and restore
~~~

## Contributing and license

Before opening a pull request, run `npm run build`, `npm test`, relevant Docker validation, and `git diff --check`. Keep behavior, operations documentation, and tests aligned; never add secrets or generated data.

No license file is present. Reuse and redistribution require project-owner approval until a license is added.

