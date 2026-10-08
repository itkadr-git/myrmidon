---
divergence-section: Трек 5 — эксплуатация
settings-section: Bot containers (G-series, the 28.09 "option B" plan)
---

## changelog-en

### Deferred bot image rollout applies itself when the bot frees up (BOT-ROLLOUT, part C)

- A bot that was busy when its image rollout reached it (a running turn, the
  owner in a chat conversation, or someone else's maintenance window) no longer
  waits for the next deploy: the reconcile pass records the deferral in the
  `myrmidonBotRolloutDeferred` key of `instance_settings.general` (row-locked,
  like the maintenance and canary keys), and a watcher in the same 60-second
  reconciliation sweep retries the recorded bots.
- A retry goes out as soon as the bot reports no running work (the maintenance-port
  busy signal the rollout path reads); it runs through the regular
  `applyBotContainerNow` (same per-bot lock, fresh card read) and the record
  is removed on success.
- A bot busy longer than `MYRMIDON_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC` (default
  3600) is no longer waited on: the retry skips the busy gate, the reconciler
  opens the maintenance window, drains the in-flight run to its end (runs are
  never interrupted, OPE-3638) and switches the container after the current turn.
- A record that did not converge within 4x the max wait is retired: dropped,
  logged in the reconcile activity log and the audit feed
  (`myrmidon.bot_rollout.deferred_retired`).

## changelog-ru

### Отложенный выкат образа бота применяется сам, когда бот освободился (BOT-ROLLOUT, часть C)

- Бот, занятый в момент раскатки своего образа (идёт ход, владелец в чате с
  ботом или чужое окно обслуживания), больше не ждёт следующего выката: проход
  сверки записывает отложенное применение (ключ `myrmidonBotRolloutDeferred` в
  `instance_settings.general`, с блокировкой строки, как у обслуживания и
  канарейки), а наблюдатель внутри того же 60-секундного прохода повторяет
  применение для записанных ботов.
- Повтор уходит, как только у бота нет работающих прогонов (тот же сигнал
  занятости порта обслуживания, что читает сам путь раскатки): применение идёт
  через обычный `applyBotContainerNow` — та же блокировка на бота, то же
  свежее чтение карточки — и при успехе запись снимается. Бот переходит на
  новый образ в пределах окна выката, без нового выката.
- Бот, не освободившийся дольше
  `MYRMIDON_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC` (по умолчанию 3600), перестаёт
  ожидаться: повтор идёт без проверки занятости, реконсайлер сам открывает
  окно обслуживания, дренит идущий прогон до конца (прогоны не прерываются —
  правило OPE-3638) и переключает контейнер сразу после текущего хода.
- Запись, так и не применившаяся за ограниченный срок (4× максимального
  ожидания), ретирается: снимается, сбой пишется в журнал сверки и в ленту
  активности (`myrmidon.bot_rollout.deferred_retired`) — зависшая запись не
  крутится вечно.

## divergence

| BOT-ROLLOUT | Отложенный drift контейнера бота применяется без нового выката: проход сверки, вернувший `deferred` при реальном изменении (drift образа/шаблона или restart-класс профиля), пишет запись `{botKey, agentId, targetImage, firstDeferredAt, attempts, lastReason}` в ключ `myrmidonBotRolloutDeferred` в `instance_settings.general` (замок строки, перенос через `updateGeneral` как у R3/R5-B); наблюдатель внутри того же 60-с свипа (одна строка вызова в `startBotContainerReconciliation`, логика в `deferred-reconciler.ts`) повторяет `applyBotContainerNow` для записанных ботов: свободный бот (нет running-прогонов по тому же порту обслуживания, что читает раскатка) применяется сразу, успех снимает запись; бот, занятый дольше `MYRMIDON_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC` (по умолчанию 3600), применяется без статус-гейта — существующий путь pause-and-apply сам открывает окно, дренит ход до конца (прогоны не прерываются, OPE-3638) и переключает; запись старше 4× maxWait помечается ошибкой и ретирается с событием в activity (`myrmidon.bot_rollout.deferred_retired`) — вечного цикла нет | `server/src/myrmidon/bot-containers/index.ts` (вызов наблюдателя за маркером и запись/снятие в `applyBotContainerNow`), `server/src/services/instance-settings.ts` (перенос ключа `myrmidonBotRolloutDeferred`) + новые файлы `server/src/myrmidon/bot-containers/deferred-{store,reconciler}.ts`; вендорские сервисы только вызываются | Факт rc.2: постоянно занятые боты остаются на старом образе навсегда — отложенный drift ждёт только следующего прохода свипа, а свип бесконечно откладывает | `server/src/myrmidon/bot-containers/deferred-rollout.myrmidon.test.ts` (запись deferred и свобода свипа; применение на следующем проходе без нового выката; таймаут MAX_WAIT — apply без статус-гейта, без прерывания run; backstop ретирает после grace) — сторож красный на main: записи нет вообще | Никогда, наше поведение. Уходит вместе со всей серией G/R5: удалить вставки `myrmidon(BOT-ROLLOUT)` и модули | (этот PR) |

## settings-en

| `MYRMIDON_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC` | BOT-ROLLOUT | `3600` | How long (in seconds) a deferred bot image rollout waits for the bot to free itself before the retry drops the busy gate: past this wait the apply runs through the reconciler's own pause-and-apply path — it opens the agent's maintenance window, drains the in-flight run to its end (runs are never interrupted) and recreates the container right after the current turn | From 60 to 86400; empty, non-integer or out of bounds — `3600` is taken. Read on every watcher pass (each reconciliation sweep), a change applies without a restart. The backstop retires a record that never converged within 4× this wait. Applies only while `MYRMIDON_BOT_CONTAINERS` is enabled |

| `MYRMIDON_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC` | BOT-ROLLOUT | `3600` | Сколько (в секундах) отложенный выкат образа бота ждёт, пока бот освободится, прежде чем повтор снимет проверку занятости: сверх этого ожидания применение идёт собственным путём pause-and-apply реконсайлера — открывает окно обслуживания агента, дренит идущий прогон до конца (прогоны не прерываются) и пересоздаёт контейнер сразу после текущего хода | От 60 до 86400; пусто, не целое или вне пределов — берётся `3600`. Читается на каждом проходе наблюдателя (каждый свип сверки), изменение применяется без перезапуска. Страховка ретирает запись, не применившуюся за 4× этого ожидания. Действует, только пока включён `MYRMIDON_BOT_CONTAINERS` |
