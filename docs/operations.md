# Runbook vận hành Zalo–Telegram Bridge bằng Docker

## Tóm tắt

Chạy production bằng service `bridge` trong `compose.yaml`; toàn bộ trạng thái bền vững nằm trong named volume `zalo-tg-data`. Trước lần chạy tiếp theo, bắt buộc thu hồi Telegram bot token đã xuất hiện trong output chẩn đoán, cấp token mới và khai báo ít nhất một `TG_OWNER_IDS`. Sau khi build, chỉ seed dữ liệu cũ một lần, khởi động container, kiểm tra cả liveness và readiness, rồi theo dõi `/queue` để xử lý các delivery có trạng thái `UNKNOWN`.

Named volume production được khai báo là `external`, nên `docker compose down -v` không xóa volume này. Dù vậy, không dùng lệnh đó như một bước cleanup thông thường và tuyệt đối không chạy `docker volume rm zalo-tg-data` khi chưa có backup đã kiểm tra; lệnh xóa volume trực tiếp sẽ làm mất SQLite database, Zalo credentials, message mapping và media đã lưu.

## 1. Phạm vi và cấu trúc dữ liệu

Các tên trong runbook này đã được đối chiếu với cấu hình hiện tại:

```text
compose.yaml
└── service: bridge
    ├── image: zalo-tg-bridge:local
    ├── named volume: zalo-tg-data -> /app/data
    ├── health state tạm thời: /tmp/health/health.json
    └── temporary media: /tmp

/app/data
├── bridge.db                 # SQLite database chính
├── bridge.db-wal             # Có thể tồn tại khi tiến trình đang chạy
├── bridge.db-shm             # Có thể tồn tại khi tiến trình đang chạy
├── credentials.json          # Zalo credentials, là secret
├── topics.json               # Legacy state/shadow state
├── settings.json             # Legacy state/shadow state
├── msg-map.json              # Legacy state/shadow state
├── backups/
└── media/
```

Container không mở port và kết nối Telegram bằng long polling. Vì vậy không cần treo browser tab. `restart: unless-stopped` tự khởi động lại bridge sau lỗi hoặc sau khi Docker daemon khởi động lại.

SQLite dùng WAL (Write-Ahead Logging), `synchronous=FULL`, migration có checksum và durable delivery queue. Một SQLite lease ngăn hai instance dùng chung database chạy đồng thời.

SQLite cũng là recovery source cho `topics.json`, `settings.json` và `msg-map.json`. Trước khi listener/worker chạy, bridge hydrate các compatibility store này từ SQLite. Nếu legacy JSON hỏng nhưng SQLite còn dữ liệu, file được tái tạo atomically; nếu cả hai nguồn đều không có bản phục hồi, startup dừng để tránh reset im lặng.

Trong `NODE_ENV=production`, `DATABASE_PATH` và `ZALO_CREDENTIALS_PATH` bắt buộc phải nằm bên trong `DATA_DIR`. Guardrail này ngăn cấu hình Docker chạy được nhưng cold backup volume lại bỏ sót database hoặc credentials.

## 2. Việc bắt buộc trước khi triển khai

### 2.1. Thu hồi Telegram bot token đã lộ

Telegram bot token hiện tại đã từng xuất hiện trong output chẩn đoán. Phải xem token đó là đã bị lộ, kể cả khi repository không chứa token.

Thực hiện trong BotFather:

1. Dùng `/revoke`, chọn đúng bot để vô hiệu hóa token cũ.
2. Nhận token mới từ BotFather.
3. Cập nhật riêng giá trị `TG_TOKEN` trong `.env`.
4. Không gửi token qua Telegram, issue, commit, ảnh chụp màn hình hoặc log hỗ trợ.

Không chạy `docker compose config` mà thiếu `--quiet`, vì output đầy đủ có thể render environment và làm lộ secret. Chỉ dùng:

```powershell
docker compose config --quiet
```

### 2.2. Khai báo owner

Ứng dụng từ chối khởi động nếu thiếu `TG_OWNER_IDS`. Đây phải là Telegram numeric user ID dương, không phải username. Có thể khai báo nhiều ID, phân cách bằng dấu phẩy hoặc khoảng trắng.

Ví dụ cấu trúc, không dùng nguyên các số minh họa:

```dotenv
TG_OWNER_IDS=123456789,987654321
```

Các command có quyền cao như `/login`, `/backup`, `/restore`, `/queue` và callback quản trị được giới hạn theo danh sách này. `TG_GROUP_ID` vẫn phải là ID của Telegram supergroup đích; ID supergroup thường là số âm bắt đầu bằng `-100`.

Startup preflight yêu cầu `TG_GROUP_ID` trỏ tới supergroup đã bật Topics và bot là administrator có đủ `Manage Topics`, `Delete Messages` và `Pin Messages`. Nếu thiếu, process dừng trước khi kết nối Zalo để không nhận event mà không thể tạo topic hoặc hoàn tất relay.

Nếu chưa có `.env`, tạo từ mẫu rồi sửa bằng editor cục bộ:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Không in `.env` ra terminal và không commit file này.

## 3. Triển khai production lần đầu

Các lệnh dưới đây giả định PowerShell đang ở root của repository.

### 3.1. Kiểm tra cấu hình và build image

`npm test` và audit là deployment gate (cổng kiểm soát trước triển khai), không chỉ là bước chẩn đoán tùy chọn:

```powershell
npm ci
npm run build
npm test
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
git diff --check

docker volume create zalo-tg-data
docker compose config --quiet
docker compose build --pull bridge
```

`docker volume create` là idempotent: nếu volume đã tồn tại, Docker giữ nguyên dữ liệu và chỉ trả lại tên volume. `compose.yaml` khai báo volume này là external để Compose không tự xóa hoặc tạo lại nó. Tên mặc định là `zalo-tg-data` và có thể được đổi bằng `BRIDGE_DATA_VOLUME`, chủ yếu phục vụ restore/cutover có rollback.

Build production dùng stage `runtime` của `Dockerfile`, chạy dưới UID/GID `10001`, cài Chromium và FFmpeg trong image, đồng thời build TypeScript ngay trong image. Node base image được pin cả tag lẫn digest; Chromium/FFmpeg vẫn đến từ Debian package repository, nên sau mỗi rebuild vẫn phải chạy smoke test TGS và ghi nhận version thực tế.

Image có OCI labels `source`, `version` và `revision`. Build cục bộ mặc định ghi revision là `local-dirty`; khi tạo release, đặt `BUILD_REVISION` bằng Git commit triển khai và dùng `BRIDGE_IMAGE` để chọn tag bất biến thay vì tái sử dụng tag local.

### 3.2. Seed dữ liệu cũ đúng một lần

Chỉ thực hiện bước này khi cần đưa dữ liệu hiện có từ `./data` và `./credentials.json` vào named volume. `compose.seed.yaml` mount repository vào `/seed/repository` ở chế độ read-only và tắt network cho one-shot seed container; nhờ vậy `credentials.json` không tồn tại sẽ thật sự được script báo là thiếu thay vì Docker tự tạo một directory tại đường dẫn đó. Seed chỉ copy file khi file đích chưa tồn tại, nên chạy lại không ghi đè state đã có.

Seed overlay reset `env_file`, nên container này không nhận `TG_TOKEN`, `TG_GROUP_ID` hoặc `TG_OWNER_IDS`. Repository source vẫn chỉ được mount read-only và seed không có network.

```powershell
docker compose -f compose.yaml -f compose.seed.yaml run --rm --no-deps --entrypoint node bridge dist/tools/seed-docker-data.js
```

Lệnh tương đương đã có trong `package.json`:

```powershell
npm run docker:seed
```

Seed kiểm tra JSON trước khi ghi và có thể copy các file sau:

- `topics.json`
- `settings.json`
- `msg-map.json`
- `update-checker.json`
- `credentials.json`

Nếu source thiếu, script báo `Source missing`; nếu target đã tồn tại, script báo `Keep existing`. Không xóa volume chỉ để chạy lại seed. Nếu muốn thay state production, dùng quy trình backup/restore có kiểm soát ở phần 9.

### 3.3. Khởi động và theo dõi

```powershell
docker compose up -d --no-build bridge
docker compose ps
docker compose logs --tail=200 bridge
```

Theo dõi log liên tục khi cần:

```powershell
docker compose logs -f --tail=200 bridge
```

Không chia sẻ log chưa redaction (che dữ liệu nhạy cảm), vì log có thể chứa Telegram/Zalo user ID, group ID, tên hội thoại hoặc nội dung lỗi từ provider.

Ví dụ trạng thái bình thường: `docker compose ps` hiển thị service `bridge` là `Up` và sau start period chuyển sang `healthy`.

## 4. Liveness và readiness

Hai kiểm tra có ý nghĩa khác nhau:

- Liveness xác nhận process còn chạy, heartbeat mới và bridge không trong quá trình shutdown.
- Readiness yêu cầu đồng thời `storage=ready`, `telegram=ready`, `zalo=ready`.

Compose healthcheck hiện dùng liveness. Container có thể vẫn là `healthy` khi Zalo đang reconnect; vì vậy phải chạy readiness khi xác minh triển khai.

`restart: unless-stopped` chỉ restart khi process thoát; Docker Compose không tự restart một process vẫn còn sống nhưng healthcheck đã `unhealthy`. Nếu cần self-healing ở mức host, dùng một supervisor bên ngoài theo dõi health state và restart service có kiểm soát. Không chạy hai bridge cùng lúc trên một volume; SQLite instance lease sẽ từ chối instance thứ hai.

Production Compose đặt `RESTART_ON_COMMAND=true`, nên owner có thể dùng `/restart`, xác nhận inline rồi để bridge dừng listener/worker, flush state và thoát cleanly; Docker `restart: unless-stopped` tạo process mới. Khi chạy trực tiếp bằng `npm start`, giữ `RESTART_ON_COMMAND=false` trừ khi một supervisor bên ngoài có contract restart tương đương. Nếu không có contract này, command bị khóa thay vì chỉ tắt bot.

`/update` không chạy `git pull` và không sửa source. Command gọi GitHub public compare API giữa `UPSTREAM_BASE_REVISION` và `main` của `UPDATE_REPOSITORY`; production image vì vậy không cần `.git` hoặc Git binary. Khi hoàn tất một parity pass mới, chỉ cập nhật baseline sau khi behavior và regression test tương ứng đã được port. Unauthenticated API có rate limit theo source IP, nên periodic checker chỉ gọi mỗi 30 phút và failure được báo như update-check failure, không được diễn giải là đang ở bản mới nhất.

```powershell
# Liveness
docker compose exec -T bridge node dist/runtime/healthcheck.js

# Readiness
docker compose exec -T bridge node dist/runtime/healthcheck.js --readiness
```

Kết quả thành công lần lượt là `alive` và `ready`, exit code bằng `0`. Readiness thất bại sẽ nêu component chưa sẵn sàng, ví dụ:

```text
Bridge is not ready: storage=ready, telegram=ready, zalo=degraded
```

Sau mỗi deploy hoặc restore, tiêu chí chấp nhận tối thiểu là:

1. `docker compose ps` cho thấy container đang chạy.
2. Liveness thành công.
3. Readiness thành công.
4. Gửi một tin nhắn thử trong một Forum Topic đã map và xác nhận nhận được ở Zalo.
5. Gửi một tin nhắn thử từ Zalo và xác nhận đúng Telegram topic.
6. Chạy `/queue` và xác nhận không có vấn đề chưa xử lý.

## 5. Durable queue và xử lý `UNKNOWN`

Bridge persist event vào SQLite trước khi chuyển tiếp và giữ thứ tự FIFO theo từng conversation. Retry dùng lease và backoff. Các trạng thái vận hành chính:

Đây là at-least-once delivery (giao ít nhất một lần), không phải exactly-once tuyệt đối. Provider receipt được ghi đồng bộ vào SQLite ngay khi API trả về, trước khi cập nhật message mapping và trước khi delivery chuyển `SENT`. Nếu process chết khi delivery đang `SENDING`, bridge không tự retry mù: lease hết hạn chuyển sang `UNKNOWN` vì provider có thể đã nhận request. Receipt đã commit vẫn còn để operator đối soát. Hai API ngoài không cung cấp chung một idempotency key, nên vẫn còn cửa sổ rất nhỏ giữa provider acceptance và lúc SQLite commit receipt.

Ở chiều Telegram→Zalo, lỗi persist trước capture làm Telegraf không commit polling offset và process fail-fast; Telegram sẽ giao lại batch sau restart, còn update đã persist được hấp thụ bởi idempotency key. Ở chiều Zalo→Telegram, bridge persist đồng bộ ngay trong listener callback và fail-fast khi storage lỗi, nhưng Zalo client library không cung cấp upstream acknowledgement/replay contract; do đó không thể chứng minh at-least-once tuyệt đối khi chính SQLite không ghi được.

- `READY`: chờ gửi.
- `SENDING`: worker đang giữ lease và gửi.
- `RETRY`: chờ thử lại.
- `SENT`: đã xác nhận hoàn tất.
- `SKIPPED`: chủ động không gọi provider, ví dụ bot echo, duplicate hoặc policy muted/stranger; reason được lưu riêng và trạng thái này không chặn FIFO.
- `UNKNOWN`: request có thể đã đến provider nhưng bridge không nhận được xác nhận chắc chắn.
- `PERMANENT_FAILED`: lỗi được phân loại là không nên tự retry.
- `DLQ`: Dead Letter Queue (hàng đợi lỗi cuối), cần operator quyết định.

Trong Telegram group đã cấu hình, owner chạy:

```text
/queue
```

Command hiển thị tổng số delivery theo trạng thái và tối đa 10 bản ghi vấn đề mỗi trang. Dùng `/queue 2` để xem trang tiếp theo và `/queue detail <delivery-id>` để xem source event, timestamp, provider receipt theo attempt, skip audit, multipart part state và lịch sử operator action.

Nếu đổi Telegram group hoặc cần bỏ toàn bộ mapping cũ, owner dùng `/clear` để xem phạm vi rồi `/clear confirm`. Bridge chỉ nhận lệnh khi không còn delivery ở trạng thái chưa kết thúc, sau đó dừng listener/worker, xóa topic mapping và message mapping của riêng `TG_GROUP_ID` hiện tại trong một SQLite transaction rồi tự khởi động lại theo restart policy. Lệnh không xóa vật lý Telegram topic, không xóa Zalo chat và không xóa durable delivery audit. Tin Zalo mới sẽ tạo topic mapping mới. Nếu lệnh báo còn delivery đang hoạt động hoặc có vấn đề, dùng `/queue` để xử lý trước.

`UNKNOWN` chặn các delivery đứng sau trong cùng conversation để giữ FIFO. Không retry mù vì có thể tạo tin nhắn trùng. Quy trình reconciliation (đối soát) là:

1. Dùng thông tin conversation và thời điểm trong log để kiểm tra thủ công ở destination.
2. Nếu tin nhắn đã xuất hiện, xác nhận đã gửi:

   ```text
   /queue sent <delivery-id> [lý do]
   ```

3. Nếu chắc chắn tin nhắn chưa xuất hiện, đưa lại vào queue:

   ```text
   /queue retry <delivery-id> [lý do]
   ```

4. Nếu không được phép gửi lại hoặc muốn dừng xử lý, chuyển sang DLQ:

   ```text
   /queue dlq <delivery-id> [lý do]
   ```

Ví dụ: một video đã có ở Zalo nhưng delivery là `UNKNOWN` do timeout sau upload. Chọn `sent`, không chọn `retry`, để tránh gửi video lần hai.

Với split file, phải resolve từng part `UNKNOWN` trước khi requeue parent:

```text
/queue part sent <delivery-id> <part-no> <telegram-message-id> [lý do]
/queue part retry <delivery-id> <part-no> [lý do]
/queue retry <delivery-id> [lý do]
```

`part sent` dùng khi đã nhìn thấy part trong Telegram và có message ID. `part retry` chỉ dùng khi đã xác nhận part đó không xuất hiện. Các part đã `SENT` được bỏ qua ở attempt sau; chỉ part `PENDING` được upload.

Ba thao tác trên chỉ áp dụng cho `UNKNOWN`, `PERMANENT_FAILED` hoặc `DLQ`. Mỗi thao tác được ghi cùng Telegram owner ID, trạng thái trước đó, thời điểm và lý do tùy chọn. Khi chuyển sang `SENT`, `SKIPPED` hoặc `DLQ`, media reference được detach trong cùng SQLite transaction; `PERMANENT_FAILED` giữ media để operator còn có thể retry. Sao chép chính xác ID do `/queue` trả về.

## 6. Group, muted conversation và stranger message

Các flag hiện tại chỉ chi phối chiều Zalo sang Telegram:

```dotenv
ZALO_SKIP_MUTED_GROUPS=false
ZALO_SKIP_STRANGER_MESSAGES=false
```

Mặc định đều là `false` để ưu tiên không mất tin nhắn:

- Zalo group vẫn được chuyển tiếp, kể cả group đang mute.
- Group hoặc direct conversation đang mute được forward sang Telegram với `disable_notification=true`, nên dữ liệu vẫn đầy đủ nhưng không phát notification.
- Tin nhắn cá nhân từ người chưa có trong friend list vẫn được chuyển tiếp.
- Mỗi group hoặc direct conversation được map tới một Telegram Forum Topic.

Nếu đặt `ZALO_SKIP_MUTED_GROUPS=true`, bridge bỏ qua group có mute đang còn hiệu lực. Cache mute đọc cả `groupChatEntries` và `chatEntries`, có TTL 60 giây nên thay đổi trên Zalo có thể trễ tối đa khoảng một phút. Direct conversation bị mute không bị drop; nó vẫn được lưu/chuyển tiếp ở chế độ silent để tránh mất tin. Khi đổi Zalo account trong cùng process, mute cache và friend cache được xóa.

Nếu đặt `ZALO_SKIP_STRANGER_MESSAGES=true`, bridge tải friend list và bỏ qua direct message khi user chắc chắn không nằm trong danh sách bạn bè. Khi Zalo API không tải được mute/friend state, policy fail-open: bridge vẫn chuyển tiếp để tránh mất dữ liệu. Vì vậy đây không phải cơ chế kiểm soát truy cập tuyệt đối.

Sau khi đổi flag, recreate container để environment mới có hiệu lực:

```powershell
docker compose up -d --force-recreate --no-build bridge
docker compose exec -T bridge node dist/runtime/healthcheck.js --readiness
```

Ví dụ lựa chọn:

- Muốn độ đầy đủ tin nhắn cao nhất: giữ cả hai flag là `false`.
- Muốn giảm nhiễu từ group đã mute nhưng vẫn nhận người lạ: bật riêng `ZALO_SKIP_MUTED_GROUPS`.
- Muốn bỏ qua người lạ: bật `ZALO_SKIP_STRANGER_MESSAGES`, đồng thời chấp nhận rằng friend list có thể thay đổi và API failure vẫn được forward.

## 7. Giới hạn dữ liệu và media

### 7.1. Giới hạn đang áp dụng

- Telegram sang Zalo: `TG_DOWNLOAD_MAX_MB` mặc định là 20 MiB. Cloud Bot API bị chặn cấu hình ở 200 MiB; local mode cho phép cấu hình tới 2048 MiB. Thư viện Zalo có thể nạp toàn bộ attachment vào RAM, nên tăng ngưỡng vẫn phải kèm disk headroom và load test thực tế.
- Zalo sang Telegram: file, GIF, video và voice vượt `TG_UPLOAD_PART_MB` (mặc định 45 MiB) được chia lossless thành `.part001`, `.part002`, ... rồi gửi tuần tự. Nếu Telegram chỉ nhận một phần, delivery chuyển `UNKNOWN` để operator đối soát thay vì tự gửi trùng.
- Timeout upload Telegram dùng `TG_UPLOAD_TIMEOUT_SEC` (mặc định 600 giây), tách khỏi timeout API thông thường 45 giây. Timeout không hủy chắc chắn request provider, nên kết quả vẫn đi vào `UNKNOWN`.
- Album ở production durable mode được chuyển từng item theo FIFO thay vì gom bằng debounce trong RAM. Cách này có thể làm mất giao diện album gộp, nhưng mỗi item có delivery/idempotency state riêng và sống qua restart tốt hơn.
- GIF gửi sang Zalo được nén về ngưỡng an toàn 5.000.000 byte; nếu vẫn vượt ngưỡng sau các preset nén, delivery thất bại.
- Media spool mặc định 200 MiB cho một object và 5 GiB tổng cộng. Có thể điều chỉnh bằng `MEDIA_MAX_OBJECT_MB` và `MEDIA_SPOOL_MAX_MB`; tổng quota phải lớn hơn hoặc bằng object quota. Chỉ tăng sau khi kiểm tra disk headroom và load test thực tế.
- Media hết hạn được detach/cleanup khi boot và định kỳ mỗi giờ, nên container chạy lâu không giữ object terminal vô hạn.
- Delivery `SENT` và `SKIPPED` được purge theo batch sau `DELIVERY_SENT_RETENTION_DAYS` (mặc định 90 ngày). `UNKNOWN`, `PERMANENT_FAILED` và `DLQ` không bị purge tự động.
- Readiness của storage chuyển `degraded` nếu dung lượng trống dưới `DATA_MIN_FREE_MB` (mặc định 512 MiB).
- `/tmp` là tmpfs 1 GiB và mất khi container restart.
- Container bị giới hạn 2 GiB RAM, 2 CPU, 256 MiB shared memory và 256 process.

Zalo là dependency không chính thức trong dự án này; giới hạn upload thực tế cho các media type khác có thể thay đổi theo phía Zalo. Tôi không thể khẳng định một ngưỡng ổn định ngoài các giới hạn đã được code áp dụng.

### 7.2. Local Telegram Bot API

Local Bot API là opt-in qua `compose.local-bot-api.yaml`. Lấy `api_id` và `api_hash` từ tài khoản Telegram của operator, lưu riêng trong `.env`, rồi khai báo:

```dotenv
TG_API_ID=123456
TG_API_HASH=replace-with-private-api-hash
LOCAL_BOT_API=true
TG_LOCAL_SERVER=http://telegram-bot-api:8081
ZALO_TG_SHARED_TMP_ROOT=/var/lib/telegram-bot-api
TG_DOWNLOAD_MAX_MB=20
TG_UPLOAD_PART_MB=45
```

`LOCAL_BOT_API` và hai path được overlay đặt lại khi chạy Compose; vẫn nên giữ chúng trong `.env` rõ ràng nếu cùng file được dùng cho local execution. Trước khi chuyển một bot đang dùng cloud API sang local server, thực hiện quy trình migration của Telegram Bot API để đóng cloud session hiện tại.

Validate và khởi động:

```powershell
docker compose -f compose.yaml -f compose.local-bot-api.yaml config --quiet
docker compose -f compose.yaml -f compose.local-bot-api.yaml up -d --build
docker compose -f compose.yaml -f compose.local-bot-api.yaml ps
docker compose -f compose.yaml -f compose.local-bot-api.yaml exec -T bridge node dist/runtime/healthcheck.js --readiness
```

Overlay tạo named volume `zalo-tg-telegram-local` và mount nó tại work directory chuẩn `/var/lib/telegram-bot-api` trong cả hai container. One-shot service `shared-temp-init` đặt permission cho non-root bridge. File Telegram tải xuống và media tạm bridge cần upload đều nằm dưới root này. `/app/data` không được mount sang Bot API container, nên SQLite và Zalo credentials không nằm trong shared volume. Port 8081 chỉ được expose trong Compose network, không publish ra host.

Bridge chỉ chấp nhận `file:` download nằm dưới `ZALO_TG_SHARED_TMP_ROOT`; path traversal hoặc path ngoài root bị từ chối. Với upload, bridge dùng `file://` zero-copy chỉ khi source cũng nằm trong shared root. Nếu local Bot API trả HTTP 400 mô tả lỗi local file URL/path, bridge retry đúng một lần bằng multipart. HTTP 400 không liên quan file và network timeout không kích hoạt fallback, tránh che lỗi logic hoặc tạo duplicate sau outcome mơ hồ.

Muốn thử file lớn hơn cloud limit, tăng đồng thời các quota liên quan và giữ tổng spool lớn hơn object quota. Ví dụ cấu hình 500 MiB:

```dotenv
TG_DOWNLOAD_MAX_MB=500
TG_UPLOAD_PART_MB=500
MEDIA_MAX_OBJECT_MB=500
MEDIA_SPOOL_MAX_MB=5120
```

Không đặt 2048 MiB chỉ vì parser cho phép. Trước hết kiểm tra free disk của cả `zalo-tg-data` và `zalo-tg-telegram-local`, RAM peak của `zca-js`, upload timeout và behavior thực tế của Zalo. Chunking lossless phía Zalo→Telegram vẫn hoạt động khi giữ `TG_UPLOAD_PART_MB=45`; manifest cố định SHA-256, byte range, filename, target topic và trạng thái từng part.

Để quay lại cloud API, chạy lại base Compose không kèm overlay và force-recreate `bridge`. Không xóa local Bot API volume cho tới khi xác nhận không còn file/cached session cần giữ.

### 7.3. Độ bền media hiện tại

SQLite lưu event trước khi chuyển tiếp. Ở cả hai chiều, sau lần download thành công đầu tiên, media được hash, atomic rename vào `/app/data/media` và gắn với delivery; retry đọc lại blob local sau khi kiểm tra size và SHA-256, không cần gọi lại URL provider. File transcode và binary part chỉ nằm ở `/tmp`, nhưng source cùng multipart manifest/receipt bền vững cho phép tái tạo đúng các part còn `PENDING`. Khi delivery `SENT`, `SKIPPED` hoặc `DLQ`, reference được tháo và object chỉ bị cleanup sau retention period. `PERMANENT_FAILED` giữ media vì operator vẫn có thể requeue. Tombstone chưa xóa được khỏi filesystem vẫn được tính vào quota để tránh báo dư dung lượng giả.

Khoảng chưa thể loại bỏ hoàn toàn là crash trong lúc download đầu tiên, trước khi object được stage; lần retry vẫn phải tải lại URL Zalo hoặc Telegram. Binary Telegram chưa được tải ngay trong capture transaction vì download dài sẽ giữ polling update quá lâu; staging diễn ra ở delivery attempt đầu tiên. Với file vượt giới hạn cloud Bot API, bật và kiểm tra local Bot API deployment như phần 7.2 trước khi tăng ngưỡng.

Theo dõi dung lượng:

```powershell
docker compose exec -T bridge sh -c "df -h /app/data /tmp; du -sh /app/data /app/data/media 2>/dev/null || true"
docker system df -v
```

## 8. Backup logic trong Telegram

Các command Telegram là logical backup, không thay thế backup toàn bộ named volume:

- `/backup`: topic map và settings.
- `/backup state`: thêm runtime message map, không chứa credentials.
- `/backup full`: chứa state/secret và phải xem như secret; mặc định bị chặn bởi `ALLOW_SECRET_BACKUP=false`.
- `/restore`: restore JSON state từ file được reply; không tự ghi `.env` hoặc Zalo credentials.

Không khuyến nghị `/backup full` cho vận hành định kỳ vì file secret được truyền qua Telegram. Chỉ khi chủ động chấp nhận rủi ro mới đặt `ALLOW_SECRET_BACKUP=true`, recreate container và tắt lại ngay sau thao tác. `.env` không được mount thành file trong container nên full backup không chứa Telegram token, nhưng vẫn có thể chứa Zalo credentials. Dùng cold backup của named volume ở phần 9 và lưu archive ở nơi mã hóa, ngoài máy chạy bridge.

Trước `/backup state` và `/backup full`, bridge flush `msg-map.json` để không bỏ sót thay đổi còn trong debounce timer. File JSON tạm trong `/app/data/backups` được xóa ngay sau khi Telegram gửi xong hoặc gửi thất bại; command này không tạo retention archive cục bộ.

## 9. Backup và restore named volume

### 9.1. Cold backup production

Ưu tiên dùng `scripts/backup-docker-volume.ps1` thay vì ghép lệnh `docker run`
thủ công. Script thực hiện các bước sau:

- Xác minh volume và image tồn tại.
- Từ chối backup nếu volume đang được một container khác ngoài service `bridge`
  hiện tại sử dụng.
- Chỉ dừng service khi chính script phát hiện service đang chạy, và chỉ khởi động
  lại khi chính script đã dừng service đó.
- Copy `bridge.db`, WAL và SHM sang `tmpfs`, rồi chạy `quick_check` và
  `foreign_key_check`; source volume luôn được mount read-only trong bước này.
- Tạo archive qua file `.partial`, sau đó mới đổi tên thành `.tgz`.
- Sinh sidecar `.sha256` và `.manifest.json`; manifest ghi image ID, schema
  version và kết quả kiểm tra SQLite.
- Chỉ xóa artifact hết hạn có đúng pattern tên của volume trong output directory.

Kiểm tra trước, không thay đổi container, volume hoặc file:

```powershell
.\scripts\backup-docker-volume.ps1 `
  -VolumeName zalo-tg-data `
  -ImageName zalo-tg-bridge:local `
  -RetentionDays 30 `
  -DryRun
```

Tạo backup thật:

```powershell
.\scripts\backup-docker-volume.ps1 -RetentionDays 30
```

Mặc định script lấy volume từ `BRIDGE_DATA_VOLUME`, image từ `BRIDGE_IMAGE`
và ghi vào `./backups`. Có thể override bằng `-VolumeName`, `-ImageName`
và `-OutputDirectory`. Nếu bridge vốn đang dừng, script không tự khởi động nó.

Archive chứa `credentials.json`, conversation metadata và nội dung durable payload; phải lưu như secret. Copy cả `.tgz` và `.sha256` sang storage khác máy. `.env` nằm ngoài volume nên phải backup riêng trong secret manager hoặc encrypted storage, không đưa vào Git.
Giữ cả `.manifest.json` để biết backup được tạo bằng image và schema version nào.

Sau khi bridge chạy lại:

```powershell
docker compose exec -T bridge node dist/runtime/healthcheck.js --readiness
```

### 9.2. Restore sang volume mới và cutover có rollback

Không restore đè trực tiếp volume đang chạy. Quy trình an toàn là kiểm tra hash, giải nén sang volume mới, sửa ownership, kiểm tra SQLite, rồi mới đổi `BRIDGE_DATA_VOLUME`. Volume cũ được giữ nguyên để rollback.

Luôn chạy `DryRun` trước. Ví dụ dưới đây giả định archive và file
`.sha256` cùng nằm trong `./backups`:

```powershell
$BackupPath = (Resolve-Path '.\backups\zalo-tg-data-YYYYMMDD-HHMMSS.tgz').Path
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$RestoreVolume = "zalo-tg-data-restore-$Stamp"

.\scripts\restore-docker-volume.ps1 `
  -ArchivePath $BackupPath `
  -TargetVolumeName $RestoreVolume `
  -DryRun
```

Nếu preflight đạt, bỏ `-DryRun`:

```powershell
.\scripts\restore-docker-volume.ps1 `
  -ArchivePath $BackupPath `
  -TargetVolumeName $RestoreVolume
```

Script bắt buộc có sidecar `.sha256`, từ chối volume đã tồn tại, pin image theo
immutable image ID, kiểm tra lại hash sau khi extract, từ chối symlink/special
file, đặt UID/GID `10001:10001`, áp dụng migration hiện tại và chạy
`dist/tools/verify-docker-data.js`. Nếu restore lỗi, script chỉ xóa volume có
ownership label đúng với operation do chính nó vừa tạo; dùng
`-KeepFailedVolume` khi cần giữ volume lỗi để điều tra.

Script không sửa `.env`, không start bridge và không tự cutover. Nếu sidecar
hash nằm ở vị trí khác, truyền `-HashPath`; nếu cần image khác, truyền
`-ImageName`. Volume restore cũng chứa credentials và phải được xem là secret.

Cutover:

1. Dừng bridge bằng `docker compose stop --timeout 180 bridge`.
2. Sửa dòng `BRIDGE_DATA_VOLUME` trong `.env` thành đúng giá trị đang nằm trong biến `$RestoreVolume`, ví dụ `zalo-tg-data-restore-20260730-120000`.
3. Chạy:

   ```powershell
   docker compose config --quiet
   docker compose up -d --force-recreate --no-build bridge
   docker compose exec -T bridge node dist/runtime/healthcheck.js
   docker compose exec -T bridge node dist/runtime/healthcheck.js --readiness
   docker compose logs --tail=200 bridge
   ```

4. Chạy smoke test hai chiều và `/queue` như phần 4.

Nếu validation thất bại, rollback bằng cách dừng bridge, đổi `BRIDGE_DATA_VOLUME` trong `.env` về tên volume cũ, rồi chạy lại `docker compose up -d --force-recreate --no-build bridge`. Không xóa volume cũ hoặc archive cho tới khi hệ thống mới đã chạy ổn định qua khoảng retention do bạn quy định.

Seed ở phần 3.2 không phải restore: seed không chép `bridge.db`, WAL, durable queue hoặc media spool.

### 9.3. Chạy backup định kỳ bằng Windows Task Scheduler

Không cần treo terminal hoặc browser tab. Tạo một task chạy bằng account riêng
có quyền dùng Docker và quyền ghi vào output directory:

- **Program/script**: `powershell.exe`
- **Arguments**:
  `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "G:\Tool\zalo\zalo-tg-refactor\scripts\backup-docker-volume.ps1" -RetentionDays 30`
- **Start in**: `G:\Tool\zalo\zalo-tg-refactor`
- Chọn giờ ít lưu lượng; bảo đảm Docker Desktop/daemon đã chạy trước trigger.
- Bật retry khi task lỗi, nhưng không chạy song song hai instance của cùng task.
- Kiểm tra `Last Run Result` và xác nhận mỗi lần thành công có đủ bộ ba
  `.tgz`, `.sha256`, `.manifest.json`.

Không schedule restore tự động. Ít nhất mỗi tháng, chọn một backup, restore sang
volume rehearsal mới, xác minh thành công rồi xóa đúng volume rehearsal. Việc
backup chỉ nằm cùng máy chưa đủ cho disaster recovery; phải sao chép artifact
đã mã hóa sang storage khác máy.

## 10. Giới hạn còn lại

Các giới hạn sau đã được giữ minh bạch thay vì mô tả hệ thống như exactly-once:

- Không thể tự xác minh provider acceptance sau hard crash. Delivery `SENDING` hết lease đi vào `UNKNOWN`, chặn FIFO và cần operator đối soát.
- Zalo listener library không có acknowledgement/replay contract. Bridge fail-fast khi capture vào SQLite lỗi, nhưng một event Zalo đúng lúc storage hỏng vẫn có thể không được provider phát lại.
- Durable queue hiện bao phủ message hai chiều. Undo, reaction, group/friend event, callback và một số poll correlation vẫn có phần state in-memory; restart có thể làm mất correlation của các event phụ này dù message chính còn nguyên.
- Bảng `conversation_policies` đã có trong schema để mở rộng, nhưng runtime hiện dùng hai global flag `ZALO_SKIP_MUTED_GROUPS` và `ZALO_SKIP_STRANGER_MESSAGES`; chưa có command quản trị per-conversation hoặc quarantine workflow.
- Telegram→Zalo stage binary vào persistent spool ở delivery attempt đầu tiên, không phải ngay trong capture transaction. Nếu provider file biến mất trước lần stage đầu tiên thì delivery không thể tự phục hồi.
- Durable album được ưu tiên theo từng item FIFO, nên giao diện album gộp không được bảo toàn.
- Local Telegram Bot API có unit/config proof nhưng vẫn cần smoke test thật với `TG_API_ID`, `TG_API_HASH`, bot session và file lớn trước production acceptance; CI không sở hữu các secret/provider session đó.
- Upstream Go TUI và shell installer không được đưa vào runtime này. Chúng kéo thêm toolchain/binary và mutable checkout flow không phù hợp container read-only, durable SQLite recovery và PowerShell runbook đang là deployment authority.

Ví dụ: nếu một split file báo `Telegram accepted 2/3 part(s)` và part 3 là `UNKNOWN`, không chạy `/queue retry` ngay. Kiểm tra topic đích, dùng `/queue part sent ... 3 <message-id>` nếu part 3 đã xuất hiện, hoặc `/queue part retry ... 3` nếu chắc chắn chưa xuất hiện. Sau đó `/queue retry` chỉ upload các part còn `PENDING`; hai part đã có receipt không bị gửi lại.
