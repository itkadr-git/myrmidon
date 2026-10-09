---
divergence-section: 1.7 — AUTO-UPDATE-SETTINGS, часть B (окно обслуживания, режим, канарейка)
settings-section: 1.7 — AUTO-UPDATE-SETTINGS part B: maintenance window, update mode, fleet canary
---

## changelog-en

### Board update policy: maintenance window, mode, canary (1.7-AUTO-UPDATE-B)

The board update now has a policy the deploy scheduler executes: the maintenance
window (days/hours), the update mode (manual, or automatic by the release tag
after a human approval) and the fleet canary (a share of the bots first, the rest
only when that share is healthy). The policy lives in `instance_settings.general`
under `myrmidonAutoUpdate`, is read on every tick (runtime change, no restart) and
shows where each value comes from — the interface or a forced env override.

A verified deploy whose window is shut waits in the new `waiting_window` status:
nothing touches the host, the job names the moment the window opens, and it is
still cancellable. When the window opens the scheduler resumes the same job. A
deploy of the fleet is not one wave: the board switch runs first, then the canary
batch, and only a healthy batch lets the rest follow (new `fleet_canary` phase);
a failed batch ends the update as `canary_failed` with the fleet left on the
previous image.

The policy is edited in the current interface (Instance → General, "Product
updates"): `GET`/`PATCH /api/myrmidon/auto-update` (read — board, write — instance
admin) and `POST`/`DELETE /api/myrmidon/auto-update/approvals[/:tag]` for
approving and withdrawing a release. In automatic mode the tick starts an approved
release inside the window without a click and claims the approval, so it never
starts twice; the journal says `auto_started` for it.

## changelog-ru

### Политика обновления доски: окно обслуживания, режим, канарейка (1.7-AUTO-UPDATE-B)

У обновления доски появилась политика, которую исполняет планировщик выката:
окно обслуживания (дни/часы), режим обновления (вручную или автоматически по
метке релиза после одобрения человеком) и канарейка парка ботов (сначала доля
ботов, остальные — только при её здоровье). Политика лежит в
`instance_settings.general` под ключом `myrmidonAutoUpdate`, читается на каждом
тике (меняется на ходу, без перезапуска) и показывает источник каждого значения —
интерфейс или принудительное переопределение из env.

Проверенный выкат при закрытом окне встаёт в новый статус `waiting_window`: хост
не трогается, работа называет момент открытия окна и остаётся отменяемой. Когда
окно открывается, планировщик продолжает ту же работу. Выкат парка — не одна
волна: сначала переключается доска, затем канареечная доля ботов, и только её
здоровье пропускает остальных (новая фаза `fleet_canary`); провал доли завершает
обновление статусом `canary_failed`, парк остаётся на прежнем образе.

Политика правится в текущем интерфейсе (Instance → General, раздел «Product
updates»): `GET`/`PATCH /api/myrmidon/auto-update` (чтение — board, запись —
instance admin) и `POST`/`DELETE /api/myrmidon/auto-update/approvals[/:tag]` —
одобрение и отзыв релиза. В автоматическом режиме тик сам стартует одобренный
релиз в окне, без нажатия, и помечает одобрение запущенной работой, поэтому
дважды он его не начнёт; в журнале это `auto_started`.

## divergence

| 1.7-AUTO-UPDATE-B | Окно обслуживания, режим обновления и канарейка парка как настройки экземпляра: политика `myrmidonAutoUpdate` (окно — дни/часы UTC, `waiting_window` вне окна вместо открытия окна; режим `manual`/`auto_release`, автостарт только по одобренному релизу; канарейка `canary.{enabled,sharePercent,minBots,maxBots,healthSettleSec}` — доля ботов первой, остальные по её здоровью, провал — терминальный `canary_failed`). Ключ переносится через вендорскую запись `general` тем же приёмом, что R5-A/R3, и читается на каждом тике — настройка меняется без перезапуска, источник значения виден | Вендор: `server/src/services/instance-settings.ts` (перенос ключа `myrmidonAutoUpdate` через `updateGeneral` — метка `myrmidon(1.7-AUTO-UPDATE-B)`). Наши файлы: `server/src/myrmidon/deploy-jobs/auto-update.ts` (чистая политика: окно, режим, канарейка, одобрения), `auto-update-store.ts` (чтение/запись ключа и перенос его через вендорскую запись), правки `deploy-jobs/{domain,settings,service}.ts` (статусы `waiting_window`/`fleet_canary`/`canary_failed`, поля работы, гейт окна и фаза канарейки в тике) | Пункт 1.7 AUTO-UPDATE-SETTINGS B: окно/режим/канарейка задаются в интерфейсе и исполняются планировщиком выката; выкат на бой по-прежнему только с одобрения человека, зависимость — UPD1 (автооткат) | `server/src/myrmidon/deploy-jobs/auto-update.myrmidon.test.ts` (окно: закрытое — откладывает, открытое — продолжает; канарейка: провал доли не пускает остальных, здоровье пускает, время наблюдения, отсутствие порта парка), `service.myrmidon.test.ts` | Никогда, наше поведение. Уходит вместе с политикой обновления: убрать статусы `waiting_window`/`fleet_canary`/`canary_failed`, модуль `auto-update*.ts` и метку в `instance-settings.ts` | (этот PR) |

## settings-en

| `myrmidonAutoUpdate.window` (settings area, `instance_settings.general`) | 1.7-AUTO-UPDATE-B | `{ days: [], fromMinute: 180, toMinute: 300 }` | When an update may start: days of the week (0 = Sunday…6 = Saturday, UTC) and the hours as minutes from midnight. No days means no window at all — a deploy may start at any time, and the interface says so | A verified deploy started outside the window waits in `waiting_window` (nothing touches the host), names `windowOpensAt` and resumes by itself when the window opens; `MYRMIDON_DEPLOY_WINDOW_WAIT_TIMEOUT_SEC` bounds the wait |
| `myrmidonAutoUpdate.mode` (settings area) | 1.7-AUTO-UPDATE-B | `manual` | Every deploy starts from the operator's click, as before | `auto_release` — an approved release tag starts the deploy at the window; without a human approval in `approvals` nothing starts, and the approval is per release tag |
| `myrmidonAutoUpdate.canary` (settings area) | 1.7-AUTO-UPDATE-B | `{ enabled: true, sharePercent: 25, minBots: 1, maxBots: 4, healthSettleSec: 300 }` | How the fleet follows a healthy board switch: the first batch is `ceil(sharePercent)` of the bots, at least `minBots` and at most `maxBots`; the rest follows only when that batch is healthy, after at least `healthSettleSec` of watching | `enabled: false` moves the whole fleet in one batch. A failed batch ends the update as `canary_failed` and the rest stays on the previous image; `MYRMIDON_DEPLOY_CANARY_TIMEOUT_SEC` bounds the phase |

## settings-ru

| `myrmidonAutoUpdate.window` (область настроек, `instance_settings.general`) | 1.7-AUTO-UPDATE-B | `{ days: [], fromMinute: 180, toMinute: 300 }` | Когда обновлению можно начинаться: дни недели (0 — воскресенье…6 — суббота, UTC) и часы как минуты от полуночи. Пустой список дней — окна нет вовсе, выкат разрешён в любое время, и интерфейс это показывает | Проверенный выкат, начатый вне окна, встаёт в `waiting_window` (хост не трогается), называет `windowOpensAt` и продолжается сам при открытии окна; ожидание ограничено `MYRMIDON_DEPLOY_WINDOW_WAIT_TIMEOUT_SEC` |
| `myrmidonAutoUpdate.mode` (область настроек) | 1.7-AUTO-UPDATE-B | `manual` | Каждый выкат начинается нажатием оператора, как раньше | `auto_release` — одобренная метка релиза запускает выкат в окне; без одобрения человеком в `approvals` ничего не стартует, одобрение выдаётся на конкретную метку |
| `myrmidonAutoUpdate.canary` (область настроек) | 1.7-AUTO-UPDATE-B | `{ enabled: true, sharePercent: 25, minBots: 1, maxBots: 4, healthSettleSec: 300 }` | Как парк ботов следует за здоровым переключением доски: первая доля — `ceil(sharePercent)` ботов, не меньше `minBots` и не больше `maxBots`; остальные идут только при её здоровье, не раньше `healthSettleSec` наблюдения | `enabled: false` — весь парк одной волной. Провал доли завершает обновление статусом `canary_failed`, остальные остаются на прежнем образе; фаза ограничена `MYRMIDON_DEPLOY_CANARY_TIMEOUT_SEC` |