<a href="README.md"><img src="https://flagcdn.com/20x15/us.png" alt="English" width="20" height="15"> English</a> · <a href="README.vi.md"><img src="https://flagcdn.com/20x15/vn.png" alt="Tiếng Việt" width="20" height="15"> Tiếng Việt</a>

<hr>

# zalo-tg

Bridge hai chiều giữa Zalo và Telegram. Mỗi cuộc trò chuyện trực tiếp hoặc nhóm Zalo được map vào một Forum Topic trong Telegram supergroup; message, media, reply, reaction, recall, poll và một số group event được đồng bộ theo hai chiều.

Bridge chạy như một process Node.js lâu dài. SQLite và Docker named volume lưu state, media, mapping và delivery đang chờ qua các lần restart, nâng cấp và restore có kiểm soát.

Topic group được route bằng Zalo group ID, không bằng tên. Tên Zalo là nguồn
authoritative và được bridge tự đối soát sau login/reconnect cùng chu kỳ 30 phút;
khi API metadata lỗi, bridge dùng tên đã lưu hoặc placeholder theo group ID thay
vì tên thành viên gửi tin.

## Tính năng chính

- Relay text và media hai chiều, tự động map conversation vào Forum Topic.
- Đồng bộ reply, mention, reaction, recall, contact, location, poll và một số group event.
- SQLite inbox và delivery queue bền vững, giữ FIFO theo conversation.
- At-least-once delivery, retry, lease, provider receipt và kết quả `UNKNOWN` để operator xử lý.
- Media spool bền vững, giới hạn kích thước, dọn object hết hạn và multipart Telegram upload.
- Đăng nhập Zalo bằng QR qua Telegram.
- Đăng nhập QR qua Web hoặc PC-App, xem đầy đủ group/member, backfill history, offline auto-reply và quản lý friend request.
- Tùy chọn local Telegram Bot API với shared volume giới hạn theo path và multipart fallback an toàn.
- Deployment preflight, SQLite instance lease, liveness và readiness check.
- Docker runtime được harden: non-root user, read-only root filesystem, bỏ capability, giới hạn tài nguyên và external named volume.

## Mục lục

- [Tech stack](#tech-stack)
- [Yêu cầu](#yêu-cầu)
- [Bắt đầu](#bắt-đầu)
- [Kiến trúc](#kiến-trúc)
- [Cấu hình](#cấu-hình)
- [Telegram commands](#telegram-commands)
- [Script và test](#script-và-test)
- [Triển khai và vận hành](#triển-khai-và-vận-hành)
- [Xử lý lỗi](#xử-lý-lỗi)
- [Bảo mật](#bảo-mật)
- [Cấu trúc project](#cấu-trúc-project)
- [Đóng góp và giấy phép](#đóng-góp-và-giấy-phép)

## Tech stack

| Thành phần | Công nghệ |
| --- | --- |
| Ngôn ngữ | TypeScript, ES2022, strict mode |
| Runtime | Node.js 24 trong production image; Node.js 18+ khi local |
| Telegram | Telegraf và Bot API long polling |
| Zalo | `zca-js` |
| Persistence | SQLite qua `better-sqlite3`, WAL mode, migration có version |
| Media | FFmpeg, Chromium/Puppeteer, `image-size`, durable media spool |
| Build | TypeScript compiler và `tsx` |
| Deployment | Docker Compose; có kèm systemd unit cũ |

## Yêu cầu

- Node.js 18+ và npm 9+ để chạy local.
- FFmpeg trong `PATH` để convert voice và xử lý media. Production image đã có sẵn.
- Telegram bot tạo bằng [@BotFather](https://t.me/BotFather).
- Telegram supergroup private đã bật Forum Topics. Bot cần quyền **Manage Topics**, **Delete Messages**, **Pin Messages** và reaction access.
- Zalo account đang hoạt động. Session nằm trong `credentials.json` hoặc credentials path đã cấu hình.
- Docker Engine và Docker Compose v2 cho production deployment được khuyến nghị.

## Bắt đầu

### 1. Cài dependency

~~~bash
git clone <repository-url>
cd zalo-tg-refactor
npm ci
~~~

`npm ci` dùng lockfile và cài native dependency cho `better-sqlite3`.

### 2. Cấu hình bridge

~~~powershell
Copy-Item .env.example .env
~~~

Đặt tối thiểu các giá trị sau trong `.env`:

~~~dotenv
TG_TOKEN=replace-with-telegram-bot-token
TG_GROUP_ID=-1001234567890
TG_OWNER_IDS=123456789,987654321
~~~

`TG_GROUP_ID` phải là supergroup ID âm. Mỗi giá trị trong `TG_OWNER_IDS` phải là Telegram user ID dương. Không commit `.env`, `credentials.json`, SQLite file hoặc backup.

### 3. Chạy local

~~~bash
npm run dev
~~~

Command này chạy `src/index.ts` bằng `tsx watch`. Lần đầu sử dụng, gửi `/login` trong Telegram group đã cấu hình và quét QR bằng ứng dụng Zalo mobile.

~~~bash
npm run build
npm start
~~~

Chuỗi lệnh trên compile vào `dist/` rồi chạy production entrypoint.

### 4. Chạy Docker Compose

~~~powershell
docker volume create zalo-tg-data
docker compose config --quiet
docker compose build --pull bridge
docker compose up -d --no-build bridge
docker compose ps
docker compose logs --tail=200 bridge
~~~

Service không publish host port vì dùng Telegram long polling. Data được mount tại `/app/data` từ external volume `zalo-tg-data`. Để import data repository vào volume mới đúng một lần:

~~~powershell
npm run docker:seed
~~~

Để bật local Telegram Bot API, khai báo `TG_API_ID`, `TG_API_HASH` rồi dùng overlay được duy trì cùng repository:

~~~powershell
docker compose -f compose.yaml -f compose.local-bot-api.yaml config --quiet
docker compose -f compose.yaml -f compose.local-bot-api.yaml up -d --build
~~~

Overlay không publish port 8081. Hai container chỉ dùng chung một volume media riêng tại cùng absolute path; Zalo credentials và SQLite data không được mount sang Bot API service.

### 5. Xác minh deployment

~~~powershell
docker compose exec -T bridge node dist/runtime/healthcheck.js
docker compose exec -T bridge node dist/runtime/healthcheck.js --readiness
~~~

Output cần có là `alive` rồi `ready`. Trước khi chấp nhận deployment, hãy gửi một test message thật theo mỗi chiều.

## Kiến trúc

### Luồng runtime

~~~text
Telegram update (long polling) ─┐
                                ├─ handler ─ durable SQLite inbox/queue ─ provider API
Zalo listener event ────────────┘                                  │
                                                                   └─ message/topic mapping
~~~

Startup validate config, mở SQLite, chạy migration có checksum, import legacy JSON nếu cần, hydrate compatibility store, recover media download dở, lấy single-instance lease và khởi động durable worker. Telegram permission được kiểm tra trước relay Zalo. Nếu Zalo chưa authenticated, Telegram vẫn hoạt động để operator dùng `/login`.

### Durability và recovery

- SQLite là recovery source cho topic/message link, alias, setting, delivery attempt, receipt, media object và operator action.
- Delivery state là `READY`, `SENDING`, `RETRY`, `SENT`, `SKIPPED`, `UNKNOWN` và `PERMANENT_FAILED`.
- Bridge có ngữ nghĩa **at least once**, không phải exactly once. Request có thể đã đến provider trước khi crash sẽ thành `UNKNOWN`, thay vì được replay mù.
- FIFO được giữ theo từng conversation. Dùng `/queue` để kiểm tra delivery đang queue, retry hoặc chưa chắc chắn.
- `topics.json`, `settings.json` và `msg-map.json` legacy được import, sau đó có thể hydrate atomically từ SQLite.

### Persistent layout

~~~text
/app/data/
├── bridge.db                 # SQLite database; WAL có thể tạo -wal và -shm
├── credentials.json          # Zalo session secret
├── topics.json               # legacy compatibility state
├── settings.json             # legacy compatibility state
├── msg-map.json              # legacy compatibility state
├── media/                    # durable media object
└── backups/                  # application backup artifact nếu bật
~~~

Health heartbeat nằm tại `/tmp/health/health.json` trong production. Readiness yêu cầu `storage`, `telegram` và `zalo` đều `ready`; Compose healthcheck chỉ test liveness.

## Cấu hình

Copy `.env.example` thành `.env`. ID, boolean, số hoặc production path không hợp lệ sẽ fail fast khi startup.

### Bắt buộc

| Variable | Mô tả | Ví dụ |
| --- | --- | --- |
| `TG_TOKEN` | BotFather token | `123456:replace-me` |
| `TG_GROUP_ID` | Supergroup ID đích; số âm | `-1001234567890` |
| `TG_OWNER_IDS` | User ID có quyền cao, phân tách bằng dấu phẩy/khoảng trắng | `123456789,987654321` |

### Runtime và storage

| Variable | Mặc định | Mục đích |
| --- | --- | --- |
| `DATA_DIR` | `./data` local; `/app/data` trong Docker | Root cho application state |
| `DATABASE_PATH` | `<DATA_DIR>/bridge.db` | SQLite database; production phải nằm trong `DATA_DIR` |
| `ZALO_CREDENTIALS_PATH` | `credentials.json` local; `/app/data/credentials.json` Docker | Zalo session; production phải nằm trong `DATA_DIR` |
| `HEALTH_DIR` | `DATA_DIR` | Thư mục chứa `health.json` |
| `BRIDGE_DATA_VOLUME` | `zalo-tg-data` | External Docker volume |
| `BRIDGE_IMAGE` | `zalo-tg-bridge:local` | Docker image reference |
| `BUILD_REVISION` | `local-dirty` | OCI revision label |
| `BUILD_VERSION` | `1.0.0` | OCI version label |

### Limit và feature flag

| Variable | Mặc định | Giới hạn hoặc tác dụng |
| --- | ---: | --- |
| `TG_DOWNLOAD_MAX_MB` | 20 | Tối đa 200 MB với cloud API; 2048 MB trong local mode |
| `TG_UPLOAD_PART_MB` | 45 | Tối đa 200 MB với cloud API; 2048 MB trong local mode |
| `TG_UPLOAD_TIMEOUT_SEC` | 600 | Tối đa 3600 giây |
| `MEDIA_MAX_OBJECT_MB` | 200 | Tối đa 2048 MB |
| `MEDIA_SPOOL_MAX_MB` | 5120 | Tối đa 102400 MB |
| `DELIVERY_SENT_RETENTION_DAYS` | 90 | Tối đa 3650 ngày |
| `DATA_MIN_FREE_MB` | 512 | Ngưỡng dung lượng trống |
| `ZALO_SKIP_MUTED_GROUPS` | false | Bỏ qua message từ muted group |
| `ZALO_SKIP_STRANGER_MESSAGES` | false | Bỏ qua DM từ người không phải friend |
| `UPDATE_CHECK_ENABLED` | false trong production | Bật update notification |
| `UPDATE_REPOSITORY` | `williamcachamwri/zalo-tg` | Public GitHub upstream được check read-only |
| `UPSTREAM_BASE_REVISION` | `155b6cc` | Upstream commit cuối đã audit vào fork |
| `ALLOW_SECRET_BACKUP` | false | Cho phép backup chứa secret |
| `RESTART_ON_COMMAND` | false; production Compose đặt true | Chỉ cho `/restart` khi có process supervisor |
| `TG_API_ROOT` | unset | Bot API root tùy chọn; đọc `docs/operations.md` trước |
| `LOCAL_BOT_API` | false | Bật local Bot API file semantics |
| `TG_LOCAL_SERVER` | unset | Local Bot API URL, thường là `http://telegram-bot-api:8081` |
| `ZALO_TG_SHARED_TMP_ROOT` | OS temp | Absolute path dùng chung với local Bot API service; overlay dùng `/var/lib/telegram-bot-api` |

Boolean nhận `1/true/yes/on` và `0/false/no/off`.

## Telegram commands

| Command | Mục đích |
| --- | --- |
| `/login` | Đăng nhập Zalo bằng QR |
| `/loginweb`, `/loginapp` | Chọn Web hoặc PC-App login; App mode refresh hidden-member data |
| `/status` | Xem bridge và provider status |
| `/topic list\|info\|delete` | Xem hoặc bỏ topic mapping |
| `/search <query>` | Tìm friend và tạo direct-message topic |
| `/addfriend`, `/friendrequests` | Quản lý friend request Zalo |
| `/addgroup`, `/joingroup`, `/leavegroup` | Quản lý nhóm Zalo |
| `/group_info`, `/group_infoall`, `/history` | Xem group và replay history gần đây qua durable relay |
| `/autoreply` | Cấu hình delayed DM auto-reply với durable cooldown reservation |
| `/recall` | Recall message Zalo do bot gửi |
| `/queue` | Xem queue, retry và delivery `UNKNOWN` |
| `/backup`, `/restore` | Backup/restore application có kiểm soát |
| `/settings`, `/members`, `/kick`, `/clear` | Thao tác quản trị |
| `/seed`, `/admin`, `/update`, `/restart` | Operator diagnostic, update check và supervised restart |
| `/help`, `/menu` | Xem command catalog hiện tại |

Hành động có quyền cao bị giới hạn bởi `TG_OWNER_IDS`. Giữ group private vì member thường vẫn relay được message.

## Script và test

| Command | Mô tả |
| --- | --- |
| `npm run dev` | Chạy TypeScript với hot reload |
| `npm run build` | Compile `src/` vào `dist/` |
| `npm start` | Chạy bridge đã compile |
| `npm test` | Chạy TypeScript test qua Node |
| `npm run healthcheck` | Chạy compiled liveness check |
| `npm run docker:seed` | Seed Docker volume từ data repository |
| `npm run tgs:gif` | Convert TGS sticker input thành GIF |

Trước deployment:

~~~powershell
npm ci
npm run build
npm test
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
git diff --check
~~~

Test bao phủ config, migration/recovery, legacy import, durable relay, media spool, authorization, command registration, health và provider policy.

## Triển khai và vận hành

Docker Compose là deployment path được duy trì. Production container chạy UID/GID 10001, read-only root filesystem, không có Linux capability, có `no-new-privileges`, `/tmp` giới hạn, RAM 2 GiB và 2 CPU.

~~~powershell
docker compose build --pull --build-arg BUILD_REVISION=$(git rev-parse HEAD) --build-arg BUILD_VERSION=1.0.0 bridge
docker compose up -d --no-build bridge
~~~

Không chạy hai instance cùng một volume. SQLite lease là safety net, không phải cơ chế multi-instance được hỗ trợ.

Development Compose:

~~~powershell
docker compose -f compose.yaml -f compose.dev.yaml up --build bridge
~~~

Profile này mount `src/` read-only, chạy `npm run dev` và lưu development state trong `zalo-tg-dev-data`.

Đọc [docs/operations.md](docs/operations.md) trước khi làm production. Tài liệu mô tả rotate token, deployment đầu tiên, seed/import, queue handling, backup, restore, rollback và acceptance check.

~~~powershell
./scripts/backup-docker-volume.ps1 -DryRun
./scripts/backup-docker-volume.ps1
./scripts/restore-docker-volume.ps1 -ArchivePath .\backups\zalo-tg-data-YYYYMMDD-HHMMSS.tgz -DryRun
~~~

Backup chứa credentials, verify SQLite integrity và tạo SHA-256 cùng manifest. Restore luôn target volume mới, verify archive/database và không tự sửa `.env` hoặc Compose cutover.

## Xử lý lỗi

### Startup dừng

~~~powershell
docker compose logs --tail=200 bridge
~~~

Kiểm tra Telegram variable thiếu, group/owner ID sai, production database hoặc credentials path nằm ngoài `DATA_DIR`, thiếu Telegram administrator permission hoặc instance khác đang dùng volume đó.

### Liveness pass nhưng readiness fail

~~~powershell
docker compose exec -T bridge node dist/runtime/healthcheck.js --readiness
~~~

Mọi component phải ready. `zalo=degraded` thường là Zalo reconnect hoặc cần `/login`. Compose không restart process còn chạy nhưng unhealthy; dùng supervisor bên ngoài nếu cần self-healing ở host.

### Delivery là `UNKNOWN`

Dùng `/queue` và xem receipt/attempt trước retry. Replay mù có thể duplicate vì provider có thể đã nhận request.

### Media conversion lỗi

Kiểm tra FFmpeg, Chromium, `MEDIA_MAX_OBJECT_MB`, `MEDIA_SPOOL_MAX_MB` và dung lượng trống theo `DATA_MIN_FREE_MB`.

### State dường như bị mất

Xác nhận named volume đúng đang mount. Không xóa volume để cleanup; restore vào volume mới, verify rồi mới cutover có chủ đích.

## Bảo mật

- Rotate Telegram token ngay nếu token xuất hiện trong log, diagnostic, screenshot hoặc chat.
- Không commit hoặc chia sẻ `.env`, `credentials.json`, SQLite file hay backup archive.
- Dùng Telegram group private với member tin cậy.
- Giữ `ALLOW_SECRET_BACKUP=false` trừ khi quy trình access-controlled yêu cầu.
- Xem `credentials.json` như password của Zalo account.
- Không expose public container port; bridge dùng long polling.

## Cấu trúc project

~~~text
src/
├── index.ts                         bootstrap, lifecycle, reconnect, shutdown
├── config.ts                        parse và validate environment
├── application/                     durable relay Telegram/Zalo và media workflow
├── bootstrap/                       environment và compatibility-store hydration
├── domain/                          ID, link, retry, provider/topic error
├── infrastructure/database/         SQLite, migration, repository, shadow state
├── infrastructure/files/            atomic file operation
├── infrastructure/media/            durable media spool
├── runtime/                         health, healthcheck, redaction, instance lease
├── store/                           compatibility topic/message/user/poll/settings store
├── telegram/                        bot, authorization, handler, command, UI
├── zalo/                            client, listener, handler, policy
├── tools/                           Docker seed/verify và TGS conversion
└── utils/                           format, download, media, Telegram queue
tests/                               TypeScript test chạy bằng Node
compose*.yaml                        production, development, seed và local Bot API overlay
Dockerfile                           multi-stage production image
docs/operations.md                   production runbook
scripts/                             PowerShell backup và restore
~~~

## Đóng góp và giấy phép

Trước pull request, chạy `npm run build`, `npm test`, Docker validation liên quan và `git diff --check`. Giữ behavior, vận hành documentation và test đồng bộ; không thêm secret hoặc generated data.

Repository chưa có file license. Reuse và redistribution cần project owner phê duyệt cho đến khi có license.
