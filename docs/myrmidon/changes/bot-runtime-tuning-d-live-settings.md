---
divergence-section: 1.6.1 — BOT-RUNTIME-TUNING D: attention-сигнал «фолбэк-модель >N% вызовов бота»
---

## changelog-en

### Model fallback signal: the threshold is a board setting, and the signal shows on the bot's card (1.6.5 BOT-RUNTIME-TUNING-D2)

- The thresholds of the model fallback signal are now instance settings, not
  deployment values read once at startup: `GET`/`PATCH
  /api/myrmidon/model-fallback/settings` read and write
  `instance_settings.general.modelFallbackSignal` (board reads, instance-admin
  writes), and every key of the answer carries its origin — `settings`, `env`
  or `default`. The sweep re-resolves the row on every tick and schedules the
  next pass with the interval it returns, so an operator changes N%, the
  window, the minimum call count or the sweep period and the next pass obeys,
  without a restart of the board. The `MYRMIDON_MODEL_FALLBACK_*` variables
  keep working as per-key overrides.
- The signal is now visible on the agent's own card, not only in the attention
  feed. `GET /api/myrmidon/companies/:companyId/model-fallback/status` returns
  the last sweep's rows — per agent: attributed calls, fallbacks, share, the
  models that actually served, and whether the agent is above the threshold —
  together with the effective numbers; the agents list renders a
  `fallback N%` badge on an agent that is above the threshold and nothing at
  all for a healthy bot.
- With the switch off the sweep does no gateway request at all: the loop stays
  armed, reads one settings row per interval and clears both registries, so a
  card or a badge from an earlier window cannot linger after the signal is
  switched off, and turning it back on takes effect within one interval.
- Nothing was duplicated from the 1.6.1 delivery of this signal (module
  `server/src/myrmidon/litellm-fallback-signal/`, attention kind
  `model_fallback_alert`): this change adds the settings and the per-agent
  status on top of it, and the existing policy tests stay green.

## changelog-ru

### Сигнал о фолбэке модели: порог стал настройкой доски, а сигнал виден на карточке бота (1.6.5 BOT-RUNTIME-TUNING-D2)

- Пороги сигнала о фолбэке модели стали настройками инстанса, а не значениями
  развёртывания, читаемыми один раз при старте: `GET`/`PATCH
  /api/myrmidon/model-fallback/settings` читают и пишут
  `instance_settings.general.modelFallbackSignal` (читают члены доски, пишет
  админ инстанса), и у каждого ключа ответа указан источник — `settings`, `env`
  или `default`. Свип перечитывает строку настроек на каждом такте и назначает
  следующий проход с тем интервалом, который вернуло разрешение: порог N%,
  окно, минимум вызовов и период свипа меняются без перезапуска доски.
  Переменные `MYRMIDON_MODEL_FALLBACK_*` продолжают работать как
  переопределения по ключу.
- Сигнал виден на карточке самого бота, а не только в ленте внимания.
  `GET /api/myrmidon/companies/:companyId/model-fallback/status` отдаёт строки
  последнего свипа — по агенту: атрибутированные вызовы, фолбэки, доля,
  фактически отработавшие модели и признак «выше порога», — вместе с
  действующими числами; список агентов рисует бейдж `fallback N%` у того, кто
  выше порога, и ничего у здорового бота.
- При выключенном выключателе свип не делает ни одного запроса к шлюзу: цикл
  остаётся взведённым, раз в интервал читает одну строку настроек и очищает оба
  реестра, поэтому карточка или бейдж прошлого окна не зависают после
  выключения, а обратное включение действует в пределах одного интервала.
- Из сдачи 1.6.1 по этому сигналу (модуль
  `server/src/myrmidon/litellm-fallback-signal/`, kind внимания
  `model_fallback_alert`) ничего не дублируется: эта правка добавляет к ней
  настройки и по-агентный статус, прежние тесты политики остаются зелёными.

## divergence

| BOT-RUNTIME-TUNING-D2 | Настройки сигнала о фолбэке модели стали настройками инстанса (порог, окно, минимум вызовов, период) и читаются на каждом такте — правка без перезапуска; на карточке агента появился бейдж доли фолбэка, живой статус отдаёт `GET /api/myrmidon/companies/:companyId/model-fallback/status`. Поведение прежнего модуля не меняется: без сохранённой строки действуют переменные и дефолты | `packages/shared/src/index.ts` (одна строка экспорта контракта, метка `myrmidon(BOT-RUNTIME-TUNING D2)`), `server/src/services/instance-settings.ts` (одна preserve-строка, метка), `server/src/app.ts` (импорт + монтирование роутов, метка), `ui/src/pages/Agents.tsx` (бейдж в строке списка и в узле дерева + проп, метка); наши файлы `packages/shared/src/myrmidon-fallback-signal.ts`, `server/src/myrmidon/litellm-fallback-signal/{settings,status,routes}.ts`, `ui/src/components/myrmidon/{modelFallbackSignalApi.ts,AgentFallbackSignalBadge.tsx}` | Порог и окно сигнала задавались только переменными окружения и читались один раз при взведении таймера: оператор не мог настроить сигнал без перезапуска доски, а сам сигнал был виден только в ленте внимания, но не на карточке бота (пункт 4 родительского эпика) | `packages/shared/src/myrmidon-fallback-signal.myrmidon.test.ts` (разрешение настроек: сохранённое → переменная → дефолт, источники ключей, отказ от неполной строки; merge патча), `server/src/myrmidon/litellm-fallback-signal/settings.myrmidon.test.ts` (чтение/запись строки `general`, preserve-ключ, отказ на патч вне диапазона), `server/src/myrmidon/litellm-fallback-signal/status.myrmidon.test.ts` (строки «выше порога»/«ниже», снимок на компанию, живое перечитывание порога между тактами без перезапуска, выключение очищает реестры и не ходит в шлюз), `ui/src/components/myrmidon/AgentFallbackSignalBadge.myrmidon.test.tsx` (бейдж выше порога, ничего ниже порога и без строки) | Никогда, наше поведение. Если вендор заведёт свои настройки сигнала о фолбэке — сверить и убрать `settings.ts`/`routes.ts`, preserve-строку и бейдж | (этот PR) |

## settings-en-replace

<!-- section: 1.6.1 — BOT-RUNTIME-TUNING D: model fallback attention signal -->
| `MYRMIDON_MODEL_FALLBACK_ENABLED` | BOT-RUNTIME-TUNING D | unset (off) | Override of the master switch of the fallback signal sweep: computes each agent's share of gateway calls served outside its card model set and records both the attention signal the feed turns into a card and the per-agent rows the agent card shows | `1`/`true` — force on. `0`/`false` — force off. Unset — the stored instance setting applies (`instance_settings.general.modelFallbackSignal`, `GET`/`PATCH /api/myrmidon/model-fallback/settings`); nothing stored — off. The loop stays armed either way, but with the switch off a tick reads one settings row, makes no gateway request and records nothing. Needs `MYRMIDON_LITELLM_*` (M2-A) to read the spend log; without them the sweep logs one warn per tick and stays idle |
| `MYRMIDON_MODEL_FALLBACK_THRESHOLD_PCT` | BOT-RUNTIME-TUNING D | `20` | Override of the fallback share (percent of attributed calls in the window) at which an agent gets the card and the agent-card badge. Exit is half of this (hysteresis: a share hovering at the threshold must not blink) | Integer from 1 to 100; a readable value outside the range is clamped, a non-integer falls back to `20`. Unset — the stored setting applies, else `20`. Read on every sweep tick: a stored change applies to the next pass without a restart |
| `MYRMIDON_MODEL_FALLBACK_MIN_CALLS` | BOT-RUNTIME-TUNING D | `20` | Override of the minimum attributed calls in the window before the agent is evaluated at all — two calls must not raise a signal | Integer from 1; a readable value below is clamped, a non-integer falls back to `20`. Unset — the stored setting applies, else `20` |
| `MYRMIDON_MODEL_FALLBACK_WINDOW_SEC` | BOT-RUNTIME-TUNING D | `3600` (1 h) | Override of the rolling window the share is computed over | Integer from 300 to 86400; values outside are clamped, a non-integer falls back to `3600`. Unset — the stored setting applies, else `3600`. Read on every sweep tick |
| `MYRMIDON_MODEL_FALLBACK_INTERVAL_SEC` | BOT-RUNTIME-TUNING D | `300` | Override of the sweep period, in seconds. A tick whose previous sweep is still running is skipped, not queued. The next pass is scheduled with the interval of the current resolution, so a stored change re-schedules the loop | Integer from 60 to 86400; values outside are clamped, a non-integer falls back to `300` |

## settings-ru-replace

<!-- section: 1.6.1 — BOT-RUNTIME-TUNING D: attention-сигнал о фолбэк-модели -->
| `MYRMIDON_MODEL_FALLBACK_ENABLED` | BOT-RUNTIME-TUNING D | не задана (выкл.) | Переопределение главного выключателя свипа сигнала фолбэка: считает каждому агенту долю вызовов шлюза, обслуженных вне набора моделей его карточки, и записывает и attention-сигнал, из которого лента собирает карточку, и по-агентные строки, которые показывает карточка бота | `1`/`true` — принудительно включить. `0`/`false` — принудительно выключить. Не задана — действует сохранённая настройка инстанса (`instance_settings.general.modelFallbackSignal`, `GET`/`PATCH /api/myrmidon/model-fallback/settings`); ничего не сохранено — выключено. Цикл взведён в любом случае, но при выключенном выключателе такт читает одну строку настроек, не делает запросов к шлюзу и ничего не записывает. Для чтения spend-лога нужны `MYRMIDON_LITELLM_*` (M2-A); без них свип пишет один warn на такт и остаётся в покое |
| `MYRMIDON_MODEL_FALLBACK_THRESHOLD_PCT` | BOT-RUNTIME-TUNING D | `20` | Переопределение доли фолбэков (процент атрибутированных вызовов окна), при которой агенту поднимается карточка и бейдж на карточке агента. Выход — половина порога (гистерезис: доля, колеблющаяся у порога, не должна мигать карточкой) | Целое от 1 до 100; читаемое значение вне диапазона зажимается, не целое откатывается к `20`. Не задана — действует сохранённая настройка, иначе `20`. Читается на каждом такте свипа: сохранённая правка действует уже на следующем проходе, без перезапуска |
| `MYRMIDON_MODEL_FALLBACK_MIN_CALLS` | BOT-RUNTIME-TUNING D | `20` | Переопределение минимума атрибутированных вызовов в окне, прежде чем агент вообще оценивается — два вызова не должны поднимать сигнал | Целое от 1; читаемое значение ниже зажимается, не целое откатывается к `20`. Не задана — действует сохранённая настройка, иначе `20` |
| `MYRMIDON_MODEL_FALLBACK_WINDOW_SEC` | BOT-RUNTIME-TUNING D | `3600` (1 ч) | Переопределение длины скользящего окна, по которому считается доля | Целое от 300 до 86400; значения вне диапазона зажимаются, не целое откатывается к `3600`. Не задана — действует сохранённая настройка, иначе `3600`. Читается на каждом такте свипа |
| `MYRMIDON_MODEL_FALLBACK_INTERVAL_SEC` | BOT-RUNTIME-TUNING D | `300` | Переопределение периода свипа, в секундах. Такт, чей предыдущий проход ещё идёт, пропускается, а не копится. Следующий проход назначается с интервалом текущего разрешения, поэтому сохранённая правка перепланирует цикл | Целое от 60 до 86400; значения вне диапазона зажимаются, не целое откатывается к `300` |

## settings-en-append

<!-- section: 1.6.1 — BOT-RUNTIME-TUNING D: model fallback attention signal -->
Since 1.6.5 (BOT-RUNTIME-TUNING-D2) these values are instance settings, resolved
on every sweep tick and on every request through
`GET`/`PATCH /api/myrmidon/model-fallback/settings` (board reads, instance-admin
writes): the stored row is the source of truth, a set environment variable
overrides its key, and nothing set means the default above. The sweep answers
`GET /api/myrmidon/companies/:companyId/model-fallback/status` with the last
pass's per-agent rows (attributed calls, fallbacks, share, the models that
served, above-threshold flag) and with the numbers it will obey, which is what
the `fallback N%` badge on the agents list renders.

## settings-ru-append

<!-- section: 1.6.1 — BOT-RUNTIME-TUNING D: attention-сигнал о фолбэк-модели -->
С 1.6.5 (BOT-RUNTIME-TUNING-D2) эти значения — настройки инстанса: они
разрешаются на каждом такте свипа и на каждом запросе через
`GET`/`PATCH /api/myrmidon/model-fallback/settings` (читает доска, пишет админ
инстанса). Источник истины — сохранённая строка; заданная переменная окружения
переопределяет свой ключ; если не задано ничего — действует умолчание из
таблицы выше. Свип отдаёт
`GET /api/myrmidon/companies/:companyId/model-fallback/status` со строками
последнего прохода по агентам (атрибутированные вызовы, фолбэки, доля,
отработавшие модели, признак «выше порога») и с действующими числами — именно
их рисует бейдж `fallback N%` в списке агентов.