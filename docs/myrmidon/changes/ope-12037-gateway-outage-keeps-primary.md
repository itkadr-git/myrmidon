---
divergence-section: 1.6.1 — BOT-RUNTIME-TUNING, часть B: компилятор профиля
settings-section: Track 5 — operations
---

## changelog-en

### Bot runtime: a lost connection to the model gateway no longer moves a run to the fallback model (TOKEN-BURN-G)

A bot reaches every model through one gateway. When the gateway restarted (about 75 s), the bot's primary model
failed with `APIConnectionError`, hermes switched the run to the fallback chain of the agent card after the second
failure and kept the run there until it ended - the primary comes back only at the start of the next turn - so a
restart of about a minute moved the rest of a run onto a paid model, although the fallback sat behind the same gateway.
Patch `29` of the bot runtime (`docker/bot-runtime/patches/`) changes this in one place, the error path of the model call:

- **A gateway that is not answering is ridden out on the primary.** An error with no HTTP answer at all (connection
  refused or reset, connect timeout, `APIConnectionError`), or a 502/503/504 whose text names no model and no provider,
  is retried against the primary with the usual growing pause for up to `HERMES_GATEWAY_OUTAGE_BUDGET_S` seconds
  (default 180) before the fallback chain is tried. For that time the retry limit of the call is lifted and the last
  pause is cut to the budget that is left. After the budget the behaviour is the old one: the fallback chain, then the
  recovery ladder. Nothing is held when the agent has no fallback.
- **An error of a model or a provider still goes to the fallback as before.** 429 and quota, `model not found`,
  `no healthy deployments`, an overloaded provider, a read timeout of a slow model, authentication errors.
- **A run on a fallback goes back to the primary.** Every `HERMES_FALLBACK_PROBE_EVERY` model calls (default 10) the
  run tries the primary again and stays on it when the call succeeds; a probe that fails walks the fallback chain
  again through the ordinary error path, and the primary's rate-limit cooldown still gates the probe.
- `0` in either variable gives the upstream behaviour back.
- To verify, stop the model gateway for about a minute while a bot run is working: the run's log shows
  `Model gateway unreachable ... retrying the primary model` and no `switching to fallback provider`, and the run finishes on
  its own model.

## changelog-ru

### Рантайм ботов: обрыв связи со шлюзом моделей больше не переводит прогон на резервную модель (TOKEN-BURN-G)

Бот ходит ко всем моделям через один шлюз. Когда шлюз перезапустился (около 75 с), основная модель бота получила
`APIConnectionError`, hermes после второго сбоя перевёл прогон на резервную цепочку из карточки агента и оставил его
там до конца (основная возвращается только в начале следующего хода), так что перезапуск около минуты переводил остаток
прогона на платную модель, хотя резерв стоял за тем же шлюзом. Патч `29` рантайма ботов
(`docker/bot-runtime/patches/`) меняет это в одном месте — в пути обработки ошибки вызова модели:

- **Шлюз, который не отвечает, пережидается на основной модели.** Ошибка без HTTP-ответа вовсе (соединение отклонено
  или сброшено, таймаут подключения, `APIConnectionError`) или 502/503/504, в тексте которой нет ни модели, ни
  провайдера, повторяется на основной с обычной нарастающей паузой до `HERMES_GATEWAY_OUTAGE_BUDGET_S` секунд
  (по умолчанию 180), и только потом идёт резервная цепочка. На это время лимит повторов вызова снят, а последняя
  пауза обрезается до остатка бюджета. После бюджета поведение прежнее: резервная цепочка, затем лестница
  восстановления. Если у агента нет резерва, ничего не удерживается.
- **Ошибка модели или провайдера по-прежнему идёт на резерв, как раньше.** 429 и квота, `model not found`,
  `no healthy deployments`, перегруженный провайдер, таймаут чтения медленной модели, ошибки авторизации.
- **Прогон на резерве возвращается на основную модель.** Каждые `HERMES_FALLBACK_PROBE_EVERY` вызовов модели
  (по умолчанию 10) прогон пробует основную снова и остаётся на ней, если вызов удался; неудавшаяся проба снова
  проходит резервную цепочку обычным путём ошибок, а кулдаун лимита основной модели по-прежнему блокирует пробу.
- `0` в любой из двух переменных возвращает поведение апстрима.
- Проверка: остановить шлюз моделей на минуту во время работы бота — в логе прогона `Model gateway unreachable ...
  retrying the primary model` и нет `switching to fallback provider`, прогон заканчивается на своей модели.

## divergence

| TOKEN-BURN-G | Обрыв связи со шлюзом моделей (соединение отклонено или сброшено, таймаут подключения, `APIConnectionError`, 502/503/504 без текста о модели и провайдере) повторяется на основной модели с нарастающей паузой до `HERMES_GATEWAY_OUTAGE_BUDGET_S` (180 с) и не включает резервную цепочку; ошибки модели и провайдера (429, квота, model not found, no healthy deployments, перегрузка, таймаут чтения) идут на резерв как раньше; прогон на резерве каждые `HERMES_FALLBACK_PROBE_EVERY` (10) вызовов пробует основную и остаётся на ней при успехе | `docker/bot-runtime/patches/29-gateway-outage-keeps-primary.patch`: новый `agent/gateway_outage.py`, `agent/turn_recovery.py` (`route_classified_error`, `compute_error_backoff`), `agent/turn_api_error.py`, `agent/turn_retry_state.py`, `agent/conversation_loop.py` | Все модели бота стоят за одним шлюзом; обрыв связи с ним роняет основную модель и все резервы одинаково, а апстрим после второго сбоя переводил прогон на резерв и оставлял его там до конца хода — факт 07.11, перезапуск шлюза около 75 с перевёл ботов на платный резерв | `docker/bot-runtime/tests/gateway_outage_fallback.py` (сборка образа: классификация ошибок и цикл повторов настоящего агента на подменённых часах) | При появлении в апстриме различения «шлюз недоступен» и «ошибка модели» до обхода резервной цепочки и возврата прогона с резерва на основную модель внутри хода | (этот PR) |

## settings-en

| `HERMES_GATEWAY_OUTAGE_BUDGET_S` (environment of the bot container) | TOKEN-BURN-G | `180` | Seconds a lost connection to the model gateway (connection refused or reset, connect timeout, `APIConnectionError`, 502/503/504 that names no model and no provider) is retried against the primary model, with growing pauses, before the fallback chain is tried. Errors of a model or a provider are not held. Nothing is held when the agent has no fallback | `0` gives the upstream behaviour back (fallback after the second failure) |
| `HERMES_FALLBACK_PROBE_EVERY` (environment of the bot container) | TOKEN-BURN-G | `10` | A run that is on a fallback tries the primary model again every this many model calls and stays on it when the call succeeds; a failing probe walks the fallback chain again, and the primary's rate-limit cooldown still gates the probe | `0` keeps a run on its fallback until the next turn (upstream behaviour) |

## settings-ru

| `HERMES_GATEWAY_OUTAGE_BUDGET_S` (окружение контейнера бота) | TOKEN-BURN-G | `180` | Сколько секунд обрыв связи со шлюзом моделей (соединение отклонено или сброшено, таймаут подключения, `APIConnectionError`, 502/503/504 без модели и провайдера в тексте) повторяется на основной модели с нарастающими паузами, прежде чем идёт резервная цепочка. Ошибки модели и провайдера не удерживаются. Если у агента нет резерва, ничего не удерживается | `0` возвращает поведение апстрима (резерв после второго сбоя) |
| `HERMES_FALLBACK_PROBE_EVERY` (окружение контейнера бота) | TOKEN-BURN-G | `10` | Прогон на резерве каждые столько вызовов модели пробует основную снова и остаётся на ней, если вызов удался; неудавшаяся проба снова проходит резервную цепочку, а кулдаун лимита основной модели по-прежнему блокирует пробу | `0` держит прогон на резерве до следующего хода (поведение апстрима) |
