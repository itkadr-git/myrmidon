---
divergence-section: Трек 5 — эксплуатация
settings-section: Bot containers (G-series, the 28.09 "option B" plan)
---

## changelog-en

### A busy bot no longer holds the bot image rollout (BOT-ROLLOUT-SKIP-BUSY, OPE-5098)

- The batch pass of `bot-image-rollout.sh` no longer waits on a busy bot: a
  bot whose agent is not paused/idle (or whose apply answers `deferred`) moves
  to a tail list and its batch ends as soon as the free bots are switched —
  the next batch starts at once. Before this, one busy bot held its whole
  batch for the full `MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC` (the rc.3 /
  rc.5 fact: 15 batches stretched to 3.5–4 h).
- After the last batch a tail pass retries the deferred bots until the same
  deadline; a bot that frees up (paused/idle) switches at once, inside the
  same run.
- Past the deadline the optional force stage applies the still-deferred bots
  without the status gate: the reconciler's own pause-and-apply path opens
  the maintenance window and drains the in-flight run to its end — a run is
  never interrupted. Gated by the new
  `MYRMIDON_BOT_IMAGE_ROLLOUT_FORCE_DEFERRED_SEC` (default = the bot timeout;
  `0` disables the stage and keeps the pre-1.6.5 apply behaviour).
- The final report lists every bot still not on the release image with its
  reason (agent status / the deferred reason of the apply outcome), and the
  summary JSON gains `deferredBots: [{id, reason}]` (an addition only — no
  existing field renamed).

## changelog-ru

### Занятый бот больше не держит раскатку образов (BOT-ROLLOUT-SKIP-BUSY, OPE-5098)

- Пачечный проход `bot-image-rollout.sh` больше не ждёт занятого бота: бот,
  чей агент не paused/idle (или чей apply ответил `deferred`), уходит в
  хвостовой список, а пачка завершается, как только свободные боты
  переключены — следующая пачка стартует сразу. Раньше один занятый бот
  держал всю пачку до полного `MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC`
  (факт rc.3 / rc.5: 15 пачек растягивались до 3,5–4 ч).
- После последней пачки хвостовой проход повторяет отложенных ботов до того же
  дедлайна; освободившийся бот (paused/idle) переключается сразу, в том же
  запуске.
- После дедлайна необязательная force-стадия применяет оставшихся занятых
  ботов без статус-гейта: собственный путь pause-and-apply реконсайлера
  открывает окно обслуживания и дренит идущий прогон до конца — прогон не
  прерывается. Управляется новой настройкой
  `MYRMIDON_BOT_IMAGE_ROLLOUT_FORCE_DEFERRED_SEC` (по умолчанию = таймауту
  бота; `0` отключает стадию и оставляет поведение apply как до 1.6.5).
- Финальный отчёт перечисляет каждого бота, так и не перешедшего на образ
  релиза, с причиной (статус агента / причина deferred из outcome), а
  summary-json дополняется `deferredBots: [{id, reason}]` (только добавка —
  существующие поля не переименованы).

## divergence

| BOT-ROLLOUT-SKIP-BUSY | Пачка раскатки не ждёт занятого бота: rc=2 из `switch_one_bot` уводит бота в `deferred_tail[]` (а не в retry пачки), пачка завершается по её неотложенным ботам; после всех пачек — хвостовой проход по `deferred_tail[]` до общего дедлайна `MYR_BOT_TIMEOUT_SEC`, далее force-стадия без статус-гейта (`switch_one_bot <id> force`) до `MYRMIDON_BOT_IMAGE_ROLLOUT_FORCE_DEFERRED_SEC` (0 = выкл); финал печатает оставшихся с причиной каждого, summary-json дополняется `deferredBots[{id, reason}]` | `scripts/myrmidon/deploy/bot-image-rollout.sh` (пачки без внутреннего ожидания, хвост, force-стадия, финальный отчёт), `deploy.env.example`, `docs/myrmidon/SETTINGS.md` | Факт rc.3/rc.5: пачка 2/15 ждала одного занятого бота до 900 с, 15 пачек — 3,5–4 ч; свободный флот должен переходить за минуты | `scripts/myrmidon/deploy/bot-image-rollout.test.mjs` (занятый бот не задерживает пачку и уходит в хвост; хвостовой проход переключает его в том же запуске после мока статуса; force-стадия применяет без статус-гейта) — сторож красный на main: пачка крутит while-цикл до дедлайна | Никогда, наше поведение. Уходит вместе со всей серией BOT-ROLLOUT: удалить вставки `myrmidon(BOT-ROLLOUT-SKIP-BUSY)` | (этот PR) |

## settings-en

| `MYRMIDON_BOT_IMAGE_ROLLOUT_FORCE_DEFERRED_SEC` | BOT-ROLLOUT-SKIP-BUSY | same as `MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC` | How long after the tail-pass deadline the still-deferred bots are applied WITHOUT the status gate: the apply goes through the reconciler's pause-and-apply path — it opens the agent's maintenance window, drains the in-flight run to its end (runs are never interrupted) and recreates the container right after the current turn. `0` disables the force stage (the pre-1.6.5 apply behaviour) | A non-negative integer; anything else is refused at rollout start (fail-closed) |
