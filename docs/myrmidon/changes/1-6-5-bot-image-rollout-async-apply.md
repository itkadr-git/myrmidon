---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### The bot image rollout script follows the async "Apply now" (BOT-IMAGE-ROLLOUT)

- Since 1.6.5 `POST /api/myrmidon/agents/:id/bot-container/apply` answers 202
  with `{applyId, status}`. `bot-image-rollout.sh` read `.outcome.kind` from that
  answer, found none and reported every bot as FAILED while the containers were
  switching in the background (the rc.12 rollout, 08.10).
- Now the script polls `GET .../bot-container/apply/:applyId` until
  `succeeded|failed` (at most `MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_WAIT_SEC`,
  default 300, every `MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_POLL_SEC`, default 4).
  `failed` fails the bot with the job's error in the journal; a timeout is
  "deferred" (the sweep finishes it). The bots of a batch are therefore switched
  one after another again.
- `succeeded` is not taken as proof (a busy bot's deferred pass is recorded as
  succeeded): the bot counts as switched only when
  `GET .../bot-container/status` shows the container running on the release
  image, otherwise it is deferred and retried. The old synchronous answer
  (`outcome.kind`) is still understood.

## changelog-ru

### Скрипт выката образов ботов понимает асинхронный «Apply now» (BOT-IMAGE-ROLLOUT)

- С 1.6.5 `POST /api/myrmidon/agents/:id/bot-container/apply` отвечает 202 и
  `{applyId, status}`. `bot-image-rollout.sh` читал из ответа `.outcome.kind`,
  не находил и помечал каждого бота FAILED, хотя контейнеры переключались в
  фоне (выкат rc.12, 08.10).
- Теперь скрипт опрашивает `GET .../bot-container/apply/:applyId` до
  `succeeded|failed` (не дольше `MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_WAIT_SEC`,
  по умолчанию 300, с шагом `MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_POLL_SEC`, по
  умолчанию 4). `failed` — бот провален, текст ошибки задачи в журнале; таймаут —
  «отложен» (доделает свип). Боты партии снова переключаются строго по одному.
- `succeeded` не считается доказательством (отложенный проход занятого бота
  записывается как succeeded): бот засчитан переключённым, только когда
  `GET .../bot-container/status` показывает работающий контейнер на образе
  релиза, иначе он отложен и повторяется. Старый синхронный ответ
  (`outcome.kind`) по-прежнему поддерживается.

## divergence

| BOT-IMAGE-ROLLOUT-ASYNC | Скрипт выката образов ботов работает с асинхронным «Apply now» 1.6.5: опрос задачи применения (`applyId`) до `succeeded\|failed` с таймаутом, затем проверка фактом через `bot-container/status`, что контейнер на образе релиза; старая синхронная форма ответа поддерживается | `scripts/myrmidon/deploy/bot-image-rollout.sh`, `deploy.env.example` | 08.10: выкат rc.12 — каждый бот FAILED на «unexpected apply outcome ''» | `bot-image-rollout.test.mjs` | Не снимать: это наш процесс выката | (этот PR) |

## settings-en

| `MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_WAIT_SEC` | BOT-IMAGE-ROLLOUT | `300` | How long the bot image rollout waits for one async apply job (202 + applyId) to reach succeeded or failed; a bot not finished in time is deferred and the periodic sweep completes it | From 0 up; whole seconds |
| `MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_POLL_SEC` | BOT-IMAGE-ROLLOUT | `4` | How often the rollout reads the apply job status | A positive integer (seconds) |

## settings-ru

| `MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_WAIT_SEC` | BOT-IMAGE-ROLLOUT | `300` | Сколько выкат образов ботов ждёт одну асинхронную задачу применения (202 + applyId) до succeeded или failed; не успевший бот отложен, периодический свип доделает | От 0, целые секунды |
| `MYRMIDON_BOT_IMAGE_ROLLOUT_APPLY_POLL_SEC` | BOT-IMAGE-ROLLOUT | `4` | Как часто выкат читает статус задачи применения | Положительное целое (секунды) |
