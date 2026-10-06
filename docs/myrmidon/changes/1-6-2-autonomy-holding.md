## changelog-en

### 1.6.2 — AUTONOMY-MATRIX: an `approval_required` cell now holds the action instead of refusing it (pause / resume / wakeup)

Pausing, resuming and waking an agent (action class `pause_wake_agents`) is now enforced at
the API seam: `POST /agents/:id/pause`, `POST /agents/:id/resume` and `POST /agents/:id/wakeup`
consult the autonomy matrix before they touch the agent. `forbidden` keeps answering
`403 autonomy_forbidden`. `approval_required` no longer answers `403
autonomy_approval_required`: the attempt is recorded as an ordinary approval card
(`tool_action_requests` + `tool_invocations`, `tool_name = autonomy_action_<class>`) and the
route answers `202 { held: true, approvalId }` without pausing, resuming or waking anyone.

The card is decided through the regular action-request approval entry
(`POST /api/tool-gateway/action-requests/:id/approve`, board-only). On approval the stored
descriptor is replayed on behalf of the original actor — pause/resume through the agent
service, wakeup through the heartbeat service — **exactly once**: the request is claimed with
a conditional `UPDATE ... WHERE status = 'approved'` (`approved` → `executing`), so a second
approval, or a retry that no longer finds the row approved, executes nothing; a rejection
executes nothing. Both rows are settled (`executed` / `failed` and `succeeded` / `failed`) and
the execution is logged as `myrmidon.autonomy.action_executed`.

The matrix is read from `instance_settings.general.myrmidonAutonomy` on every request, so
editing a cell in the Regulations UI takes effect without a restart — no env override and no
new settings key. Board and admin callers are not subject to the matrix. Guide:
`docs/myrmidon/guides/autonomy-matrix-holding-actions.md` (RU: `…ru.md`).

## changelog-ru

### 1.6.2 — AUTONOMY-MATRIX: вердикт `approval_required` теперь держит действие вместо отказа (pause / resume / wakeup)

Пауза, возобновление и побудка агента (класс действий `pause_wake_agents`) теперь
проверяются в точке API: `POST /agents/:id/pause`, `POST /agents/:id/resume` и
`POST /agents/:id/wakeup` обращаются к матрице автономии до того, как тронуть агента.
`forbidden` по-прежнему отвечает `403 autonomy_forbidden`. `approval_required` больше не
отвечает `403 autonomy_approval_required`: попытка записывается обычной карточкой
одобрения (`tool_action_requests` + `tool_invocations`, `tool_name = autonomy_action_<class>`),
а маршрут отвечает `202 { held: true, approvalId }`, никого не ставя на паузу, не
возобновляя и не будя.

Карточка решается обычным входом одобрения
(`POST /api/tool-gateway/action-requests/:id/approve`, только доска). При одобрении
сохранённый описатель повторяется от имени исходного актора — pause/resume через сервис
агентов, побудка через сервис прогонов — **ровно один раз**: запрос захватывается условным
`UPDATE ... WHERE status = 'approved'` (`approved` → `executing`), поэтому повторное
одобрение или повтор, не нашедший строку в статусе `approved`, не исполняют ничего; отказ
не исполняет ничего. Обе строки закрываются (`executed` / `failed` и `succeeded` / `failed`),
исполнение пишется в журнал как `myrmidon.autonomy.action_executed`.

Матрица читается из `instance_settings.general.myrmidonAutonomy` на каждом запросе, поэтому
правка ячейки в интерфейсе регламентов действует без перезапуска — переопределения через env
нет, новых ключей настроек нет. Вызывающие доска и админ матрице не подчиняются. Гайд:
`docs/myrmidon/guides/autonomy-matrix-holding-actions.ru.md`.

## divergence-new

### 1.6.2 — AUTONOMY-MATRIX: держание действий с вердиктом `approval_required`

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.2-AUTONOMY-HOLD | Гейт автономии держит действие вместо отказа: `holdOrAssert(req, actionClass, descriptor)` при вердикте `approval_required` записывает пару `tool_invocations` (`tool_name = autonomy_action_<class>`) + `tool_action_requests` (`pending`) и отдаёт `202 {held:true, approvalId}`; описатель для повтора `{actionClass, route, method, params, body}` лежит в `tool_invocations.policy_explanation["myrmidon.autonomy"]`, а `arguments_hash` — настоящий SHA-256 от него. Исполнение после одобрения подключено в существующий конвейер ревью: после коммита одобрения описатель повторяется от имени исходного актора (pause/resume/wakeup через `agentService`/`heartbeatService`), запрос захватывается условным `UPDATE ... WHERE status='approved'` (`approved`→`executing`) — ровно один раз; повторное одобрение или повтор, не нашедший `approved`-строку, не исполняют ничего, отказ не исполняет; обе строки помечаются `executed`/`failed` и `succeeded`/`failed`, в журнал пишется `myrmidon.autonomy.action_executed`. Карточка решается обычным входом одобрения (`POST /api/tool-gateway/action-requests/:id/approve`): удержание автономии — не инструмент шлюза (нет соединения, каталога и подписанных аргументов), поэтому вход передаёт его в `decideHeldAutonomyAction` до конвейера подписанных аргументов, который иначе отказался бы его проверить и отменил запрос; та же ветка обслуживает восстановительный обход шлюза, поэтому одобренное во время падения процесса удержание повторяется, а не виснет | Наши файлы: `server/src/myrmidon/autonomy/{gate.ts,action-execution.ts,action-execution-runtime.ts,action-decision.ts}` + тесты `gate.myrmidon.test.ts`, `action-execution.myrmidon.test.ts`, `review-wiring.myrmidon.test.ts`, `action-decision.db.myrmidon.test.ts`; в вендоре помечены `myrmidon(1.6-AUTONOMY)`: `server/src/routes/agents.ts` (три маршрута AM1 pause/resume/wakeup — `holdOrAssert` вместо 403 `autonomy_approval_required`), `server/src/services/tool-action-review.ts` (импорт `replayHeldAutonomyAction` + повтор после одобрения), `server/src/services/tool-gateway.ts` (два импорта + ветка `approveActionRequest`), `server/src/__tests__/agent-cross-tenant-authz-routes.test.ts` и `server/src/__tests__/agent-live-run-routes.test.ts` (заглушка гейта: эти наборы проверяют аренду/авторизацию, а не матрицу) | Эпик 1.6 AUTONOMY-MATRIX: вердикт `approval_required` должен держать действие в точке API, а не отказывать 403 — карточка одобрения и исполнение после «да»; механика держания и решения взята из существующего конвейера tool-действий и не дублируется | `action-decision.db.myrmidon.test.ts` (embedded-PG, реальный гейт + реальный конвейер ревью: держание → агент ещё `idle`; одобрение → агент `paused`, запрос `executed`, invocation `succeeded`, ровно одна строка `action_executed`; повторное одобрение → одна пауза; отказ → агент `idle`, `rejected`/`denied`, ноль исполнений; `allowed` → нет удержания), `action-execution.myrmidon.test.ts` (правило «ровно один раз» на фейковой БД + обёртка повтора), `gate.myrmidon.test.ts` (allowed/approval_required/forbidden/не-агент; держание пишет пару строк), `review-wiring.myrmidon.test.ts` (стражи обеих связок: повтор в конвейере ревью и ветка в `approveActionRequest` до проверки подписи), `agents.myrmidon.test.ts` (маршруты pause/resume/wakeup: `approval_required` → 202 + карточка, агент не тронут) | Никогда, наше поведение. Снятие: удалить autonomy-дерево, три вызова `holdOrAssert` в `routes/agents.ts`, повтор в `tool-action-review.ts` и ветку в `approveActionRequest` | (этот PR) |

## settings-en-append

<!-- section: 1.6 — AUTONOMY-MATRIX (Part A: matrix, enforcement, regulations API) -->
Enforced routes (1.6.2, `pause_wake_agents` action class — see
`docs/myrmidon/guides/autonomy-matrix-holding-actions.md`): `POST /agents/:id/pause`,
`POST /agents/:id/resume`, `POST /agents/:id/wakeup`. Verdicts at these seams:
`forbidden` -> 403 `autonomy_forbidden`; `approval_required` -> the action is held (approval
card in `tool_action_requests` + `tool_invocations`, answer `202 { held: true, approvalId }`,
target untouched) and is replayed exactly once after the card is approved — a rejection
replays nothing. Board/admin callers are not subject to the matrix. The matrix is read from
`instance_settings.general.myrmidonAutonomy` on every request, so a matrix edit in the UI
takes effect without a restart (no env override, no new settings keys).