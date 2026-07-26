# Plan Room Integrity — sửa đường wake + state bền của room

> Trạng thái: **P0-B, P0-C và P1 đã implement + verify** (2026-07-26) · P0-A đã bị **thu hồi**
> sau khi có bằng chứng mới · phần P2 còn lại là tuỳ chọn. Mở ngày 2026-07-26.
> Nguồn: deep review toàn bộ workflow (giáo án ↔ `profiles/root_instruction.md` v2 ↔
> `bin/herdr-agent` ↔ `herdr-plugins/attention-broker`). Không bao gồm `plugins/`
> (config amp, ngoài phạm vi).
>
> File này là **durable truth** cho plan này. Context hội thoại là cache — nếu compact
> hoặc đổi session, đọc lại file này thay vì điều tra lại từ đầu.

## Mục tiêu

Room hiện chạy được nhưng có hai lỗ nền: (1) đường wake có thể im lặng mất một
completion và không có gì phục hồi; (2) không có chỗ bền nào giữ ownership / lock /
danh sách seat, nên `guardrail #3` và sổ lock ở §8 không thể thực thi sau compact.
Sửa nền trước, không thêm feature lên trên.

## Đã thực hiện (2026-07-26)

Bộ ca hồi quy: `herdr-plugins/attention-broker/test-wake-path.sh` — 14/14 pass. Nó chạy
plugin thật với một `herdr` giả và state dir tạm, **không** chạm room sống, nên có thể chạy lại
bất cứ lúc nào. Đây là acceptance của P0-B; đừng verify bằng cách đọc code.

`attention-broker.js` + `herdr-plugin.toml`:
- Dedupe chuyển sang `state_change_seq`, state khoá theo `terminal_id`; bỏ hẳn
  `state.recent`/`signature` và cặp `prevStatus`/`notified` cũ.
- `unknown` không còn được ghi vào `lastStatus` (chỉ nhận `idle|working|done|blocked`).
- `lastNotified` chỉ được ghi **sau khi giao wake thành công** ⇒ giao lỗi thì event còn trong
  queue và seat chưa bị suppress; retry không nhân đôi entry.
- Đăng ký `pane.exited` + `pane.closed`. **Lỗ phát hiện lúc chạy thật:** event `pane.closed`
  thật *không* mang trường `agent` và pane đã rời `agent list`, nên điều kiện
  `Boolean(agentLabel)` cũ vẫn làm backstop im lặng — nay nhận diện seat qua map
  `paneTerminal` ghi lúc seat còn sống (map này cũng giữ **tên** seat, nên wake của seat chết
  đọc là `impl-x:closed` chứ không phải `pi:closed`).
- Prune theo *liveness từ `agent list`* + tuổi, không theo timer đơn thuần; nạp được state
  format cũ. `dedupe_window_ms` đổi thành `state_ttl_ms` (vẫn đọc key cũ).

`bin/herdr-agent`: chặn `--role root` (kèm `*/*`, `*..*`); rename thất bại thì thử
`<label>-<workspaceId>` rồi **báo lỗi ra stderr** thay vì nuốt; `done` lúc spawn giờ là
*ready* như lúc task (bỏ nhánh `fail_spawn` đóng pane); `read … || true` ở `submit_task`;
preflight `HERDR_ENV`/`HERDR_WORKSPACE_ID`; TTL metadata 24h → 2h (`HERDR_METADATA_TTL_MS`).

`profiles/root_instruction.md`: §2 nói rõ dùng `workspace_id` từ `agent list` để suy ra seat
của room (và **không** tin metadata pane); §3 khôi phục sàn fan-out; §7 viết lại — **một**
`herdr agent wait` có biên là đúng khi không còn stream nào khác, frozen-wait được định nghĩa
lại là "block một seat *trong khi stream khác đang cần mình*"; §10 nói thẳng context/cache
metadata **chưa được instrument**, cấm trích số room không phát ra.

`README.md`: bảng model/provider/thinking theo role thay cho ví dụ sai; nói rõ Claude chỉ làm
director. README của plugin: viết lại phần delivery/dedupe/backstop cho khớp code.

### P0-A đã bị thu hồi — bằng chứng mới

`herdr agent list` trả **`workspace_id` cho từng agent**, và `herdr-agent spawn` luôn đặt seat
vào workspace của root ⇒ "seat nào thuộc room tôi" suy được từ live state, `guardrail #3` không
cần sổ. Ledger seat sẽ là state thứ hai phải đồng bộ tay, đúng kiểu balloon. Phần **lock** thì
vẫn không có chỗ trú — nhưng room 1–2 seat chưa có va chạm thật, nên chỉ làm khi thật sự chạy
test nặng song song.

### Bỏ có chủ ý

`lastStatus` "rò rỉ" (29 entry ≈ vài KB — không phải rò rỉ thật; nay prune theo liveness nên
tự hết); xây hook telemetry cho §10 (ghi rõ là chưa instrument, rẻ hơn và trung thực hơn cả
subsystem); 3 dòng sidebar rỗng; dời `root_instruction.backup.md`;
trả lại hai tên anti-pattern `black-box workflow` / `agent hierarchy collapse` vào §11.

## Xác minh end-to-end trên room sống (2026-07-26, root `root-w3`, pane `w3:p24`)

`test-wake-path.sh` chỉ chứng minh logic plugin. Bốn ca dưới đây chạy trên **event thật** của
herdr, với seat pi thật, và wake **thật sự được inject vào pane của root** (xuất hiện ở phía Root
dưới dạng `HERDR_ATTENTION_EVENT …`). Không cần chạy lại; nếu sửa broker thì chạy lại.

| Ca | Cách tạo | Kết quả quan sát |
| --- | --- | --- |
| seat về `done` | `spawn probe-done --role scout` + task tầm thường | `woke root-w3 for 1 event(s)` → `HERDR_ATTENTION_EVENT probe-done:done` tới pane root |
| trùng tên toàn cục | spawn hai seat cùng label `probe-done` | seat thứ hai tự đổi thành `probe-done-w3` (nhánh dự phòng của helper), `title` vẫn `probe-done` |
| crash giữa lúc `working` | task `sleep 90` rồi `pane close` khi status=`working` | `pane.closed … subject=unknown` → `woke root-w3` → `HERDR_ATTENTION_EVENT probe-crash:closed` — **đúng tên seat** dù event không mang field `agent` |
| close **sau** khi đã báo done | close pane đã `done` | im lặng: `suppressed duplicate probe-done-w3: status=null prev=done seq=none notified_seq=1404` |

Hai điều ca crash chứng minh mà test giả không chứng minh được: `pane.closed` thật mang
`subject=unknown` và pane đã rời `agent list`, nên seat chỉ nhận diện được qua map
`paneTerminal` ghi lúc còn sống; và tên seat trong wake lấy từ map đó, không phải từ event.

Prune là **event-driven, không có timer**: entry của pane đã chết vẫn nằm trong `paneTerminal`
/`lastStatus` quá `state_ttl_ms` cho tới khi có event kế tiếp trong room dọn nó. Room im lặng thì
state đứng yên — đúng thiết kế, không phải rò rỉ.

Vẫn còn hở: **seat treo** (đứng `working` mà không chết) không có cơ chế nào đánh thức Root —
chỉ có doctrine §7 (một `herdr agent wait` có biên). Chưa có sổ lock.

### `display_agent`: đã sửa, kèm bằng chứng cơ chế

`--display-agent` của `report-metadata` là **tuỳ chọn**, và giá trị do source `herdr-agent` báo
sẽ **ghi đè** sự thật mà integration của runtime đã báo. Đo trực tiếp trên pane root `w3:p24`
(`agent_session.source = herdr:claude`, `agent = claude`):

| Lệnh | `display_agent` |
| --- | --- |
| `--display-agent "pi"` (đúng chữ nghĩa §1 cũ) | `pi` — pane claude tự khai là pi |
| `--clear-display-agent` | `None` → sidebar rơi về `agent` = `claude` |
| không truyền cờ display nào | `None` (không tự hồi phục nhãn cũ) |

Đây chính là gốc của "root pane báo `display_agent: pi`" trong findings — không phải bug của
herdr, mà là profile tự khai sai. §1 nay dùng `--clear-display-agent`: xoá nhãn kế thừa từ chủ
cũ của pane ID **mà không khẳng định nhãn mới**. Giữ `--source herdr-agent` (cùng source với
spawn helper) là có chủ ý — nhờ vậy token của root *thay thế* token cũ của seat đã chết thay vì
nằm cạnh nó; TTL ngắn cũng vì lý do đó.

## Bằng chứng đã xác minh trên máy (2026-07-26, herdr 0.7.5, session w3)

Đây là bằng chứng **đã quan sát trực tiếp**, không phải suy luận — không cần chạy lại:

1. Room phát `status=unknown subject=unknown` liên tục. Plugin log thật:
   `pane=w3:p10 status=unknown subject=unknown` → `pane=w3:p10 status=idle subject=pi`.
2. State đã ghi trên đĩa
   (`~/.local/state/herdr/plugins/local.attention-broker/sessions/30809cc8bcfb339a/state.json`):
   `lastStatus` có **29 entry**, trong đó 6 đang mắc ở `"unknown"`
   (`w3:p10`, `w3:p22`, `w3:p26`, `w3:p29`, `w3:p2B`, `w3:p1`); `notified: {}`;
   `recent: 0 entry`.
3. `herdr agent list` trả `state_change_seq` cho từng agent (vd `1336`) và cả
   `terminal_id` — broker đã gọi `agent list` rồi nên dùng được ngay, không cần API mới.
4. Binary herdr có thật các event `pane.exited`, `pane.closed`, `pane.created`
   (ngoài `pane.agent_status_changed`). `~/.config/herdr/plugins.json` chỉ đăng ký **một** event.
5. **Metadata sống lâu hơn seat**: pane `w3:p24` đang chạy session Claude, nhưng
   `herdr agent list` vẫn báo `title: "verify-peer"` + `tokens: {role: peer,
   model: "glm 5.2", effort: high, name: verify-peer}` của một seat pi đã chết trước đó
   vài phút. ⇒ pane ID **bị tái dùng trong vài phút** và metadata TTL 24h đè lên seat mới.
6. Root hiện báo sai agent: `root-w2` (thật là `claude`) và `root-w3` (thật là `amp`)
   đều hiện `display_agent: "pi"`.
7. Kiểm chứng bash: `[ … ] && VAR=x` trong `case` **không** làm thoát dưới `set -e`
   (an toàn); nhưng `read -r a b < <(cmd_thất_bại)` đứng độc lập **làm thoát im lặng**.

## Task theo thứ tự (foundation first, không sắp theo nhãn)

### P0-A — Sổ bền cho seat và lock  (nền, mở khoá mọi thứ khác)

`guardrail #3` ("không chạm pane bạn không tạo") và sổ lock §8 hiện chỉ tồn tại trong
context của root — mà §10 gọi context là cache. Sau compact, root vừa không được chạm
seat, vừa không biết cái gì đang lock.

- Sửa ở `bin/herdr-agent` (nhánh `spawn`): sau khi spawn thành công, append một dòng vào
  sổ bền theo workspace, gồm `pane_id`, `terminal_id`, `label`, `role`, `model`,
  `workspace_id`, timestamp.
- Cho lock trú cùng chỗ đó (resource, owner, task, điều kiện release, timeout, artifact).
- `root_instruction.md` §2 (orient) đọc sổ này khi dựng lại room.
- **Không** dùng cách suy ra "seat do tôi tạo" từ metadata `--source herdr-agent`:
  bằng chứng #5 chứng minh metadata không đáng tin.
- Acceptance: root sau compact trả lời được "seat nào tôi tạo, ai giữ lock" mà không cần
  transcript.

### P0-B — Sửa đường wake của broker (4 việc, cùng một file)

`herdr-plugins/attention-broker/attention-broker.js`:

1. **`unknown` ghi đè mất `working`** — `:94` ghi `lastStatus` cho *mọi* status, nên
   heuristic `workingToIdle` ở `:110-114` (cần `prevStatus === "working"`) bị phá bởi
   chuỗi `working → unknown → idle` ⇒ **không wake**. (Bằng chứng #1, #2.)
   Sửa: chặn phép ghi ở `:94` bằng `Boolean(subjectAgent)`, hoặc bỏ thẳng `"unknown"`.
2. **Thay heuristic bằng `state_change_seq`** (khuyến nghị mạnh) — suppress theo
   `seq <= lastNotifiedSeq[seat]`. Chắc chắn hơn cặp `prevStatus`/`notified`, miễn nhiễm
   với (1), xoá được ~30 dòng. `bin/herdr-agent:78-99` đã dựng đúng hợp đồng này rồi.
   (Bằng chứng #3.)
3. **Wake gửi-rồi-mất không bao giờ retry** — `flushRoot` `:199-204` xoá queue khi
   `pane run` exit 0; exit 0 chỉ nghĩa "đã gõ text vào pane", không nghĩa root đã tiêu thụ.
   README đang nói sai chỗ này. Sửa: chỉ xoá pending sau khi `state_change_seq` của root
   tiến lên (hoặc sau lần chuyển `working` kế tiếp của root).
4. **Code crash-backstop đã có nhưng chưa subscribe** — `shouldQueue` `:182`,
   `terminalReason` `:322`, guard `cleanupAfterDone` `:132` xử lý
   `pane.exited`/`pane.closed`, nhưng `herdr-plugin.toml:14-16` chỉ đăng ký
   `pane.agent_status_changed` ⇒ toàn bộ nhánh là code chết. Thêm 2 block `[[events]]`.
   (Bằng chứng #4.)

- Acceptance: một seat done, một seat crash, một seat bị đóng → root nhận đúng một wake
  cho mỗi trường hợp; wake không nhân đôi; không mất wake khi có `unknown` xen giữa.

### P0-C — Quyết định deadline cho §7  (quyết định profile, không phải code)

Broker không có deadline timer, turn của root kết thúc sau dispatch ⇒ seat **freeze**
(không đổi status) không đánh thức được ai, nên "mười phút là trần an toàn" ở §7 là
bất khả thi. P0-B/4 chỉ bịt được crash/exit, **không** bịt freeze.

Hướng đề xuất: khi root **không còn stream nào khác để lái**, một
`herdr agent wait --until done --timeout <ms>` có biên là nước đi *đúng* — không tốn token
trong lúc chờ, và là deadline duy nhất room có. §7 hiện đang cản đúng công cụ này, và
điều kiện "không turn nào của Root kết thúc trong mù" là không thể thỏa với room một stream.
Phương án khác: thêm deadline timer vào broker (README đã để cửa cho "a later slice").

### P1 — Chốt đúng-đắn giá rẻ ở `bin/herdr-agent`

- **`--role root` không bị chặn** — `:188` dựng `root_instruction.md`, `:194` inject vô tư.
  `:191` chỉ *lọc khỏi danh sách lỗi*; README khẳng định đã chặn nhưng không có gì thực thi.
  Một lần đánh máy = rò rỉ toàn bộ protocol vào co-worker (Lỗi #1 của giáo án). 2 dòng.
- **Rename seat thất bại trong im lặng** — `:260` nuốt mọi lỗi. Tên agent duy nhất toàn cục
  ⇒ room thứ hai spawn `reviewer` sẽ mất tên ⇒ wake đọc `pi:done` thay vì tên seat.
  Áp cùng cách đã dùng cho root (`<label>-<workspaceId>`), hoặc tối thiểu là báo lỗi.
- **`done` lúc spawn là chí tử, `done` lúc task là sẵn sàng** — `:60-62` coi `done` là
  thất bại rồi `fail_spawn` `:38` **đóng pane**, trong khi `:298` coi `done` là ready.
  Chọn một ngữ nghĩa; nhánh bất nhất này đang mang tính phá hoại.
- **`submit_task` chết không lời** — `:129` `read … < <(agent_state …)` độc lập dưới
  `set -e`. Thêm `|| seq0=0`. (Bằng chứng #7.)
- Nhỏ: `:230` dùng `$HERDR_WORKSPACE_ID` dưới `set -u` mà không preflight `HERDR_ENV`.
- Nhỏ: `profiles/root_instruction.backup.md` nên rời khỏi `profiles/` (git history đã giữ).

### P1 — Metadata & định danh

- TTL `86400000` (24h) ở `bin/herdr-agent:280` quá dài so với tuổi thọ pane ⇒ bằng chứng #5.
  Hạ về cỡ một phiên làm việc, và xoá metadata khi đóng seat.
- Broker khoá `notified`/`lastStatus` theo `pane_id` (`:93`, `:129`) trong khi
  `terminal_id` ổn định đã có sẵn và đã được dùng cho pending queue (`:153`).
  Pane ID tái dùng trong cửa sổ giữ 60s ⇒ seat này thừa hưởng state suppress của seat khác.
  Chính §11 cảnh báo "đừng coi ID cũ là danh tính bền".

### P2 — Vệ sinh & lệch doctrine

- **`dedupe_window_ms` không còn làm việc nó được ghi**: phép kiểm cửa sổ đã bị bỏ,
  `state.recent` (`:147`) chỉ còn được pruner đọc; key này giờ chỉ định cỡ một TTL khác.
  README `:37-44` đang mô tả sai. Trả lại ý nghĩa hoặc đổi tên.
- **`lastStatus` rò rỉ không giới hạn**: `pruneRecent` `:293-300` chỉ xoá `lastStatus` kèm
  một `notified` hết hạn ⇒ pane chưa từng gây wake không bao giờ được dọn (bằng chứng #2).
  Lưu `{status, at}` và prune theo tuổi.
- **§10 bảo root suy luận trên metadata room không phát ra**: context còn lại, cache
  hit rate, hot/cold, lock đang giữ, task đang sở hữu, quyền edit. `hooks/*.sh` chỉ report
  `agent_session_id`/`agent_session_path` ở SessionStart; không có hook PostCompact/Stop,
  không có script telemetry. Bài 26 (Giai đoạn 3) chưa xây. Hoặc xây phần mỏng cần dùng,
  hoặc ghi rõ §10 là định hướng — viết như hiện tại là mời root bịa số.
- **Text wake bảo root làm việc không định nghĩa**: `:196-198` "re-arm attention…" nhưng
  room không có cơ chế re-arm; §7 lại dùng từ vựng khác. Đồng bộ, hoặc cho re-arm cơ chế thật.
- **Ngưỡng sàn fan-out bị mất**: v2 §3 đẩy "effectively all substantive work" ra ngoài;
  Bước 3 của giáo án nói *đừng* fan-out khi chi phí chuyển giao lớn hơn lợi ích (v1 có, v2 bỏ)
  ⇒ đổi pre-solve lấy ceremony ở phía ngược lại. Một câu là khôi phục được.
- **Hai anti-pattern bị xoá khỏi §11**: `black-box workflow`, `agent hierarchy collapse`
  (v1 có). Giữ danh sách inline (ít ceremony) nhưng trả lại hai tên.
- **§11 nhắc Supervisor không có file** ⇒ `--role supervisor` sẽ lỗi. Ghi rõ là forward-looking.
- **Docs lệch code**: `bin/herdr-agent:9-15` vẫn nói "Model stays the caller's choice"
  và default `deepseek-v4-flash` (helper giờ tự quyết model+provider+thinking);
  README `:89-101` lặp lại cái sai đó, ví dụ `reviewer` chạy deepseek/max trong khi helper
  cấp glm-5.2/high; README `:118` ("Spawn Claude co-workers") mâu thuẫn v2 §4 "pi only".
  Trong workflow lấy mục tiêu "không phải black box", **docs chính là mental model**.
- Thẩm mỹ: root báo `--display-agent "pi"` cho root claude/amp (bằng chứng #6); comment
  trong profile gọi sai là "token `agent`"; root không báo token `role`/`model`/`effort` nên
  3/4 dòng sidebar ở `herdr-config.toml:10-15` hiện rỗng.

## Ngoài phạm vi

`plugins/amp-models.ts`, `plugins/amp-root.ts` — config agent amp, không thuộc workflow.

## Ghi chú vận hành cho plan này

- Tree đang có thay đổi chưa commit ở `bin/herdr-agent`, `herdr-config.toml`,
  `herdr-plugins/attention-broker/*`, `profiles/root_instruction.md`, `plugins/amp-models.ts`.
  Lấy baseline `git status --short` trước khi giao owner.
- `attention-broker.js` và `bin/herdr-agent` là **hai scope ghi tách biệt** → có thể song song.
  `herdr-plugin.toml` thuộc scope broker. `root_instruction.md` chỉ Root sửa (P0-C, P2).
- Sửa broker xong phải **reload plugin** và xác minh bằng
  `herdr plugin log list --plugin local.attention-broker` chứ không chỉ đọc code.
