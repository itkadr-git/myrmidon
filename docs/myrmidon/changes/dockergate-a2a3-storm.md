## changelog-en

### The board no longer storms dockergate; a fleet rollout fits the gate's limit (1.6.5-DOCKERGATE-A2A3-STORM)

- On 05.10 (1.6.5-rc.1) the board sent 5 395 allowed A2/A3 requests to
  dockergate in three minutes (~30/s against the gate's global bucket of 50/s,
  plus 394 `rate_limited` refusals) and a five-bot rollout batch took 6–10
  minutes with most applies failing on 429. The storm had four stacked causes,
  all fixed: the clone-hygiene report collector ran on the maintenance tick
  (5 s by design, `MYRMIDON_MAINTENANCE_TICK_SEC`) and asked every bot every
  tick (inspect + marker read, 74 bots ≈ 30 req/s); the reconcile pass asked
  each bot twice (`status` inspect, then `templateDrift`'s second inspect);
  the post-apply health wait polled every second; and a 429 simply failed the
  pass, only to be hammered again on the next tick.
- The collector moved onto its own timer (`MYRMIDON_CLONE_REPORT_INTERVAL_SEC`,
  default 300 s — a report is valid for 24 h) and reads each bot under the
  per-bot lock, so a report read and a rollout of the same bot never run side
  by side. The reconcile pass now probes status and template drift from a
  single inspect (`statusWithDrift`): 2 gate requests per bot per pass instead
  of 3, which puts the planned 74-bot sweep at ~2.5 req/s. The health wait
  polls every 5 s (was 1 s) within the same timeout. The dockergate client
  gained a token bucket (`MYRMIDON_DOCKERGATE_MAX_RPS`, default 20/s across all
  loops) and a 429 retry: exponential backoff with full jitter, a server
  `Retry-After` honoured when present, up to 5 retries before the pass reports
  the refusal as before.
- Meter (new test `server/src/myrmidon/bot-containers/dockergate-a2a3-storm.myrmidon.test.ts`,
  a counting fake gate): requests per bot per sweep pass 3 → 2; inspects in a
  30 s health wait 31 → ≤8; the collector 29.6 req/s → 0.5 req/s at default
  settings; a full 74-bot rollout fits its request budget into under 2 minutes
  of paced traffic at 20 req/s with the retry budget absorbed client-side, so
  the gate's own buckets see less than half their rate.

## changelog-ru

### Доска больше не штурмует dockergate; выкат флота укладывается в лимит гейта (1.6.5-DOCKERGATE-A2A3-STORM)

- 05.10 (1.6.5-rc.1) доска отправила в dockergate 5 395 разрешённых A2/A3
  запросов за три минуты (~30/с против глобального лимита гейта 50/с, плюс 394
  отказа `rate_limited`), а партия выката из пяти ботов шла 6–10 минут, и
  большинство apply падало на 429. У шквала четыре наложившихся причины — все
  устранены: сборщик отчётов clone-hygiene стоял на тике обслуживания (5 с по
  замыслу, `MYRMIDON_MAINTENANCE_TICK_SEC`) и спрашивал каждого бота на каждом
  тике (inspect + чтение маркера, 74 бота ≈ 30 запросов/с); проход сверки
  спрашивал каждого бота дважды (inspect в `status`, затем второй inspect в
  `templateDrift`); ожидание здоровья после apply опрашивало каждую секунду; а
  429 просто валил проход, чтобы на следующем тике снова колотить в гейт.
- Сборщик переехал на собственный таймер (`MYRMIDON_CLONE_REPORT_INTERVAL_SEC`,
  по умолчанию 300 с — отчёт годен 24 ч) и читает каждого бота под
  по-ботовым замком, поэтому чтение отчёта и выкат одного бота никогда не идут
  параллельно. Проход сверки получает состояние и дрейф шаблона из одного
  inspect (`statusWithDrift`): 2 запроса к гейту на бота за проход вместо 3, и
  плановый обход 74 ботов встаёт в ~2,5 запроса/с. Опрос здоровья — раз в 5 с
  (было 1 с) при том же таймауте. Клиент dockergate получил токен-бакет
  (`MYRMIDON_DOCKERGATE_MAX_RPS`, по умолчанию 20/с на все циклы вместе) и
  повтор при 429: экспоненциальная пауза с полным джиттером, уважение
  серверного `Retry-After` когда он есть, до 5 повторов, после которых отказ
  сообщается как раньше.
- Замер (новый тест `server/src/myrmidon/bot-containers/dockergate-a2a3-storm.myrmidon.test.ts`,
  считать-гейт): запросов на бота за проход обхода 3 → 2; inspect'ов в 30-
  секундном ожидании здоровья 31 → ≤8; сборщик 29,6 запроса/с → 0,5 при
  настройках по умолчанию; полный выкат 74 ботов укладывается в бюджет менее
  двух минут упорядоченного трафика при 20 запросах/с с поглощённым на стороне
  клиента бюджетом повторов —buckets гейта видят меньше половины своей скорости.

## settings-en-new

### 1.6.5 — DOCKERGATE-A2A3-STORM: board pacing toward dockergate

| `MYRMIDON_DOCKERGATE_MAX_RPS` | DOCKERGATE-A2A3-STORM | `20` | Ceiling of board→dockergate requests per second summed over every loop (reconcile sweep, health wait, clone-report collector, "apply now"): a client-side token bucket in the docker driver, so the board stays under the gate's own global bucket (50/s) with margin and a fleet rollout does not ride the limit | `0` — the bucket is off (the loops hammer the gate's bucket directly, as on 1.6.5-rc.1). Non-numeric or above 50 — the default. Configs built in code without this field (tests) also run unpaced |
| `MYRMIDON_CLONE_REPORT_INTERVAL_SEC` | DOCKERGATE-A2A3-STORM | `300` | How often the clone-hygiene report collector asks each bot's container for its report (inspect + report read under the per-bot lock). Until here it ran on the maintenance tick (5 s): 74 bots turned into ~30 gate requests per second — the 05.10 A2/A3 storm. A report is valid for 24 h, so minutes are enough | From 60 to 86400; empty, non-integer or out of range — `300`. Read at server startup (the collector starts with the bot container runtime), a change needs a restart. Applies only while `MYRMIDON_BOT_CONTAINERS` is enabled |

## settings-ru-new

### 1.6.5 — DOCKERGATE-A2A3-STORM: согласование темпа запросов доски к dockergate

| `MYRMIDON_DOCKERGATE_MAX_RPS` | DOCKERGATE-A2A3-STORM | `20` | Потолок запросов доска→dockergate в секунду на все циклы вместе (обход сверки, ожидание здоровья, сборщик отчётов клонов, «применить сейчас»): клиентский токен-бакет в docker-драйвере, чтобы доска оставалась под глобальным бакетом гейта (50/с) с запасом и выкат флота не ехал по лимиту | `0` или пусто — бакет выключен (циклы бьют прямо в бакет гейта, как в 1.6.5-rc.1). Не число или больше 50 — по умолчанию |
| `MYRMIDON_CLONE_REPORT_INTERVAL_SEC` | DOCKERGATE-A2A3-STORM | `300` | Как часто сборщик отчётов clone-hygiene спрашивает контейнер каждого бота (inspect + чтение отчёта под по-ботовым замком). До этого он стоял на тике обслуживания (5 с): 74 бота превращались в ~30 запросов к гейту в секунду — шквал A2/A3 от 05.10. Отчёт годен 24 часа, поэтому хватает минут | От 60 до 86400; пусто, не целое или вне пределов — `300`. Читается при запуске сервера (сборщик стартует вместе с рантаймом контейнеров), изменение требует перезапуска. Действует, только пока включён `MYRMIDON_BOT_CONTAINERS` |
