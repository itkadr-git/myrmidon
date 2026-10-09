---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### A busy bot no longer holds the bot image rollout (BOT-ROLLOUT-SKIP-BUSY)

- The batch pass of `bot-image-rollout.sh` no longer waits on a busy bot: a bot whose agent is not paused/idle (or whose apply answers `deferred`) moves to a tail list, and its batch ends as soon as the free bots are switched — the next batch starts at once. Before this, one busy bot held its whole batch for the full `MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC` (the rc.3 / rc.5 fact: 15 batches stretched to 3.5–4 h).
- After the last batch a tail pass retries the deferred bots until the same deadline; a bot that frees up (paused/idle) switches at once, inside the same run.
- Past the deadline an optional force stage can apply the still-deferred bots without the status gate. It is OFF by default (`MYRMIDON_BOT_IMAGE_ROLLOUT_FORCE_DEFERRED_SEC=0`): the reconciler drains only 300 s and then the maintenance interrupts a longer run, so an operator opts in with an explicit number of seconds. Without it, a still-busy bot stays deferred and the reconciler's periodic sweep completes it.
- A failed apply (HTTP error, failed job, unexpected outcome) after the card PATCH returns the card to its previous container block, so the card names the image it had before; it is skipped when the container already runs the release image. Only the card's container block is restored: agent keys the apply pass re-issued are not rolled back. A failed revert is logged and journaled loudly.
- The final report lists every bot still not on the release image with its reason (agent status / the deferred reason of the apply outcome), and the summary JSON gains `deferredBots: [{id, reason}]` (an addition only — no existing field renamed).
- Ported from main (PR #820) onto the 1.6.5 release branch together with the async-apply work of the branch: one script, no duplicate pass.

## changelog-ru

### Занятый бот больше не держит раскатку образов (BOT-ROLLOUT-SKIP-BUSY)

- Пачечный проход `bot-image-rollout.sh` больше не ждёт занятого бота: бот, чей агент не paused/idle (или чей apply ответил `deferred`), уходит в хвостовой список, а пачка завершается, как только свободные боты переключены — следующая пачка стартует сразу. Раньше один занятый бот держал всю пачку до полного `MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC` (факт rc.3 / rc.5: 15 пачек растягивались до 3,5–4 ч).
- После последней пачки хвостовой проход повторяет отложенных ботов до того же дедлайна; освободившийся бот (paused/idle) переключается сразу, в том же запуске.
- После дедлайна необязательная force-стадия может применить оставшихся занятых ботов без статус-гейта. По умолчанию она ВЫКЛЮЧЕНА (`MYRMIDON_BOT_IMAGE_ROLLOUT_FORCE_DEFERRED_SEC=0`): реконсайлер дренит лишь 300 с, дальше обслуживание прерывает долгий прогон, поэтому оператор включает стадию явным числом секунд. Без неё занятой бот остаётся отложенным, его доводит периодический свип реконсайлера.
- После неудачного apply (ошибка HTTP, упавшая задача, неожиданный исход) за PATCH карточки карточка возвращается к прежнему блоку container, то есть к прежнему образу; если контейнер уже работает на образе релиза, возврат пропускается. Восстанавливается только блок container карточки: ключи агента, перевыпущенные на проходе apply, не откатываются. Сбой возврата пишется в лог и журнал.
- Финальный отчёт перечисляет каждого бота, так и не перешедшего на образ релиза, с причиной (статус агента / причина deferred из outcome), а summary-json дополняется `deferredBots[{id, reason}]` (только добавка — существующие поля не переименованы).
- Портировано из main (PR #820) на ветку выпуска 1.6.5 вместе с работой по асинхронному apply в ветке выпуска: один скрипт, без дублирующего прохода.

## divergence

| BOT-ROLLOUT-SKIP-BUSY | Пачка раскатки не ждёт занятого бота: rc=2 из `switch_one_bot` уводит бота в `deferred_tail[]` (а не в retry пачки), пачка завершается по её неотложенным ботам; после всех пачек — хвостовой проход по `deferred_tail[]` до общего дедлайна `MYR_BOT_TIMEOUT_SEC`, далее по явной настройке force-стадия без статус-гейта (`switch_one_bot <id> force`) до `MYRMIDON_BOT_IMAGE_ROLLOUT_FORCE_DEFERRED_SEC` (по умолчанию 0 = выкл); неудачный apply после PATCH возвращает карточку (`revert_card`); финал печатает оставшихся с причиной каждого, summary-json дополняется `deferredBots[{id, reason}]` | `scripts/myrmidon/deploy/bot-image-rollout.sh` (пачки без внутреннего ожидания, хвост, force-стадия, финальный отчёт), `deploy.env.example`, `docs/myrmidon/SETTINGS.md` | Факт rc.3/rc.5: пачка ждала одного занятого бота до 900 с, 15 пачек — 3,5–4 ч; свободный флот должен переходить за минуты | `scripts/myrmidon/deploy/bot-image-rollout.test.mjs` (занятый бот не задерживает пачку и уходит в хвост; хвостовой проход переключает его в том же запуске после мока статуса; force-стадия по явной настройке применяет без статус-гейта; без настройки не запускается; упавший apply возвращает карточку) | Никогда, наше поведение. Уходит вместе со всей серией BOT-ROLLOUT: удалить вставки `myrmidon(BOT-ROLLOUT-SKIP-BUSY)` | — |

## settings-en

| `MYRMIDON_BOT_IMAGE_ROLLOUT_FORCE_DEFERRED_SEC` | BOT-IMAGE-ROLLOUT | `0` (off) | How long after the tail-pass deadline the bots that are still deferred are applied WITHOUT the status gate. Off by default: the reconciler drains only 300 s, then the maintenance interrupts a longer run. Set a number of seconds only to accept that | From 0 to 86400 |

## settings-ru

| `MYRMIDON_BOT_IMAGE_ROLLOUT_FORCE_DEFERRED_SEC` | BOT-IMAGE-ROLLOUT | `0` (выкл.) | Сколько после дедлайна хвостового прохода применяются всё ещё отложенные боты БЕЗ статус-гейта. По умолчанию выключено: реконсайлер дренит лишь 300 с, затем обслуживание прерывает долгий прогон. Число секунд задают, только принимая это | От 0 до 86400 |
