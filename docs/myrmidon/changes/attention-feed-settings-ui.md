## settings-en-new

<!-- after: 1.6.3 — PROMPT-BUDGET C: prompt-budget advice and deep analysis -->
### 1.6.6 — SETTINGS-UI C-4: attention feed windows

The "Attention feed" panel on the Instance → General settings page edits the
two windows the attention feed is built with
(`instance_settings.general.attentionFailedRunHorizonDays` and
`.attentionFeedCacheTtlSeconds`, `GET`/`PATCH /api/myrmidon/attention-feed`;
board members read, instance admins write). Each field shows its bounds, the
built-in default and whether the value in force comes from the saved settings
row or from the default. A write is partial — only the window the operator
changed — and is audited per company; the feed picks the new value up on its
next build, with no restart. Neither window has an environment variable: the
stored row (then the built-in default) is the only source, and a hand-edited
value that is not a whole number within the bounds reads as the default, the
same fallback the feed itself applies.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `attentionFailedRunHorizonDays` | 1.6.6-SETTINGS-UI C-4 | `7` | How far back the attention feed looks for an unresolved failed or timed-out run | Whole days from 1 to 365. A missing, non-integer or out-of-bounds stored value reads as the default |
| `attentionFeedCacheTtlSeconds` | 1.6.6-SETTINGS-UI C-4 | `45` | How long the built attention feed is reused per company before the next read rebuilds it | Whole seconds from 0 to 300; `0` turns the cache off. A missing, non-integer or out-of-bounds stored value reads as the default |

## settings-ru-new

### 1.6.6 — SETTINGS-UI C-4: окна ленты внимания

Панель «Лента внимания» на странице общих настроек инстанса (Instance →
General) задаёт два окна, с которыми собирается лента внимания
(`instance_settings.general.attentionFailedRunHorizonDays` и
`.attentionFeedCacheTtlSeconds`, `GET`/`PATCH /api/myrmidon/attention-feed`;
читают участники доски, пишут администраторы инстанса). У каждого поля видны
границы, встроенное умолчание и пометка, откуда взято действующее значение —
из сохранённой строки настроек или из умолчания. Запись частичная — пишется
только изменённое окно — и попадает в аудит по каждой компании; лента
подхватывает новое значение при следующей сборке, без перезапуска. Ни у
одного из окон нет переменной окружения: единственный источник — сохранённая
строка (а затем встроенное умолчание), и поправленное руками значение, не
являющееся целым числом в границах, читается как умолчание — тот же откат,
что применяет сама лента.

| Переменная | Функция | Умолчание | Что делает | Как выключить / особые случаи |
|---|---|---|---|---|
| `attentionFailedRunHorizonDays` | 1.6.6-SETTINGS-UI C-4 | `7` | На сколько дней назад лента внимания ищет неразрешённый упавший или превысивший таймаут прогон | Целые дни от 1 до 365. Отсутствующее, нецелое или выходящее за границы сохранённое значение читается как умолчание |
| `attentionFeedCacheTtlSeconds` | 1.6.6-SETTINGS-UI C-4 | `45` | Сколько секунд собранная лента внимания переиспользуется для компании до пересборки при следующем чтении | Целые секунды от 0 до 300; `0` выключает кэш. Отсутствующее, нецелое или выходящее за границы сохранённое значение читается как умолчание |
