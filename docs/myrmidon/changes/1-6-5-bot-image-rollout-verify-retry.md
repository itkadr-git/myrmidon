---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### The bot image rollout ends with a card-vs-container fact check and a standard deferred re-run pass (BOT-IMAGE-ROLLOUT)

- After the switch loop `bot-image-rollout.sh` now verifies the FACT for every
  tracked bot: the image in the agent card (`adapterConfig.container.image`)
  against the image of the running container (`GET
  /api/myrmidon/agents/:id/bot-container/status`, the same board API the script
  already uses; the rollout host is the container host). A printed per-bot
  table classifies every bot `switched | deferred(<reason>) | failed |
  mismatch` and the rollout summary JSON gains `verdict` plus the per-bot
  verification rows, so `deploy.sh` and the operator see the fact, not the
  intent.
- Exit rules follow the fact, not the apply answers: `mismatch > 0` or
  `failed > 0` — `DEGRADED`, exit 1. Only deferred bots remain — exit 0 with a
  `WARNING` and the printed re-run command. A deferred bot whose card and
  container agree is still deferred, never a mismatch; a `failed` pass outcome
  outranks a agreeing fact.
- `--retry-deferred [--wait-sec N]` (default `N=30`,
  `MYRMIDON_BOT_IMAGE_ROLLOUT_RETRY_WAIT_SEC`) is the sanctioned repeat pass:
  it reloads the deferred list from the previous rollout's summary (missing
  summary — fail closed, exit 1; never a silent empty retry), re-switches only
  those bots with `N` seconds of patience per bot, then verifies and prints
  the same table. No pass ever interrupts a running bot.

## changelog-ru

### Выкат образов ботов завершается сверкой фактом «карточка ↔ контейнер» и штатным повторным проходом отложенных (BOT-IMAGE-ROLLOUT)

- После цикла переключений `bot-image-rollout.sh` сверяет ФАКТ по каждому
  бату: образ из карточки агента (`adapterConfig.container.image`) с образом
  работающего контейнера (`GET /api/myrmidon/agents/:id/bot-container/status`,
  тот же API доски, что скрипт уже использует; хост выката и есть хост
  контейнеров). Печатается таблица `switched | deferred(<причина>) | failed |
  mismatch` по ботам, а сводка JSON получает `verdict` и строки сверки —
  `deploy.sh` и оператор видят факт, а не намерение.
- Итог по факту, а не по ответам Apply: `mismatch > 0` или `failed > 0` —
  `DEGRADED`, код 1. Только отложенные — код 0 с `WARNING` и напечатанной
  командой повторного прохода. Отложенный бот, у которого карточка и
  контейнер согласны, остаётся deferred, а не mismatch; проваленный проход
  важнее согласного факта.
- `--retry-deferred [--wait-sec N]` (по умолчанию `N=30`,
  `MYRMIDON_BOT_IMAGE_ROLLOUT_RETRY_WAIT_SEC`) — штатный повторный проход:
  список deferred берётся из сводки предыдущего выката (нет сводки — падение с
  кодом 1, молчаливый пустой повтор невозможен), переключение только этих
  ботов с ожиданием `N` секунд на бота, затем повторная сверка и та же
  таблица. Ни один проход не прерывает работающего бота.

## divergence

| BOT-IMAGE-ROLLOUT-VERIFY-RETRY | Конец выката образов ботов — сверка фактом «карточка ↔ контейнер» (таблица switched/deferred/failed/mismatch, verdict в сводке) и штатный повторный проход `--retry-deferred [--wait-sec N]` только по отложенным из сводки предыдущего выката; DEGRADED/код 1 при mismatch>0 или failed>0, при одних deferred — код 0 с WARNING и командой повтора | `scripts/myrmidon/deploy/bot-image-rollout.sh`, `deploy.env.example` | 06.10 решение п.3; выкат rc.12 показал расхождение намерения и факта | `bot-image-rollout.test.mjs` | Не снимать: итог выката обязан отвечать за факт | (этот PR) |

## settings-en

| `MYRMIDON_BOT_IMAGE_ROLLOUT_RETRY_WAIT_SEC` | BOT-IMAGE-ROLLOUT | `30` | Per-bot wait of the standard deferred re-run pass (`--retry-deferred`); the command line `--wait-sec` overrides it | A positive integer (seconds) |

## settings-ru

| `MYRMIDON_BOT_IMAGE_ROLLOUT_RETRY_WAIT_SEC` | BOT-IMAGE-ROLLOUT | `30` | Ожидание на бота в штатном повторном проходе отложенных (`--retry-deferred`); `--wait-sec` в командной строке переопределяет | Положительное целое (секунды) |
