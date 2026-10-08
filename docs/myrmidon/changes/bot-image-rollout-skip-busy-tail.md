---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### A busy bot no longer holds the bot image rollout (BOT-ROLLOUT-SKIP-BUSY)

- The batch pass of `bot-image-rollout.sh` no longer waits on a busy bot: a bot whose agent is not paused/idle (or whose apply answers `deferred`) moves to a tail list, and its batch ends as soon as the free bots are switched — the next batch starts at once. Before this, one busy bot held its whole batch for the full `MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC` (the rc.3 / rc.5 fact: 15 batches stretched to 3.5–4 h).
- After the last batch a tail pass retries the deferred bots until the same deadline; a bot that frees up (paused/idle) switches at once, inside the same run.
- Past the deadline the optional force stage applies the still-deferred bots without the status gate: the reconciler's own pause-and-apply path opens the maintenance window and drains the in-flight run to its end — a run is never interrupted. Gated by the new `MYRMIDON_BOT_IMAGE_ROLLOUT_FORCE_DEFERRED_SEC` (default = the bot timeout; `0` disables the stage and keeps the apply behaviour of the 1.6.5 rc line).
- The final report lists every bot still not on the release image with its reason (agent status / the deferred reason of the apply outcome), and the summary JSON gains `deferredBots: [{id, reason}]` (an addition only — no existing field renamed).
- Ported from main (PR #820) onto the 1.6.5 release branch together with the async-apply work of the branch: one script, no duplicate pass.

## changelog-ru

### Занятый бот больше не держит раскатку образов (BOT-ROLLOUT-SKIP-BUSY)

- Пачечный проход `bot-image-rollout.sh` больше не ждёт занятого бота: бот, чей агент не paused/idle (или чей apply ответил `deferred`), уходит в хвостовой список, а пачка завершается, как только свободные боты переключены — следующая пачка стартует сразу. Раньше один занятый бот держал всю пачку до полного `MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC` (факт rc.3 / rc.5: 15 пачек растягивались до 3,5–4 ч).
- После последней пачки хвостовой проход повторяет отложенных ботов до того же дедлайна; освободившийся бот (paused/idle) переключается сразу, в том же запуске.
- После дедлайна необязательная force-стадия применяет оставшихся занятых ботов без статус-гейта: собственный путь pause-and-apply реконсайлера открывает окно обслуживания и дренит идущий прогон до конца — прогон не прерывается. Управляется новой настройкой `MYRMIDON_BOT_IMAGE_ROLLOUT_FORCE_DEFERRED_SEC` (по умолчанию = таймауту бота; `0` отключает стадию и оставляет поведение apply как в линии rc).
- Финальный отчёт перечисляет каждого бота, так и не перешедшего на образ релиза, с причиной (статус агента / причина deferred из outcome), а summary-json дополняется `deferredBots[{id, reason}]` (только добавка — существующие поля не переименованы).
- Портировано из main (PR #820) на ветку выпуска 1.6.5 вместе с работой по асинхронному apply в ветке выпуска: один скрипт, без дублирующего прохода.

## divergence

| BOT-ROLLOUT-SKIP-BUSY | Пачка раскатки не ждёт занятого бота: rc=2 из `switch_one_bot` уводит бота в `deferred_tail[]` (а не в retry пачки), пачка завершается по её неотложенным ботам; после всех пачек — хвостовой проход по `deferred_tail[]` до общего дедлайна `MYR_BOT_TIMEOUT_SEC`, далее force-стадия без статус-гейта (`switch_one_bot <id> force`) до `MYRMIDON_BOT_IMAGE_ROLLOUT_FORCE_DEFERRED_SEC` (0 = выкл); финал печатает оставшихся с причиной каждого, summary-json дополняется `deferredBots[{id, reason}]` | `scripts/myrmidon/deploy/bot-image-rollout.sh` (пачки без внутреннего ожидания, хвост, force-стадия, финальный отчёт), `deploy.env.example`, `docs/myrmidon/SETTINGS.md` | Факт rc.3/rc.5: пачка ждала одного занятого бота до 900 с, 15 пачек — 3,5–4 ч; свободный флот должен переходить за минуты | `scripts/myrmidon/deploy/bot-image-rollout.test.mjs` (занятый бот не задерживает пачку и уходит в хвост; хвостовой проход переключает его в том же запуске после мока статуса; force-стадия применяет без статус-гейта) | Никогда, наше поведение. Уходит вместе со всей серией BOT-ROLLOUT: удалить вставки `myrmidon(BOT-ROLLOUT-SKIP-BUSY)` | — |

## settings-en

| `MYRMIDON_BOT_IMAGE_ROLLOUT_FORCE_DEFERRED_SEC` | BOT-IMAGE-ROLLOUT | same as `MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC` | How long after the tail-pass deadline the bots that are still deferred are applied WITHOUT the status gate (the reconciler opens the maintenance window and drains the in-flight run to its end — a run is never interrupted). `0` disables the force stage | From 0 to 86400 |

## settings-ru

| `MYRMIDON_BOT_IMAGE_ROLLOUT_FORCE_DEFERRED_SEC` | BOT-IMAGE-ROLLOUT | как у `MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC` | Сколько после дедлайна хвостового прохода применяются всё ещё отложенные боты БЕЗ статус-гейта (реконсайлер открывает окно обслуживания и дренит идущий прогон до конца — прогон не прерывается). `0` отключает force-стадию | От 0 до 86400 |
