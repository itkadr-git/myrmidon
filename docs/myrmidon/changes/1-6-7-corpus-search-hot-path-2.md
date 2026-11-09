---
settings-section: 1.6.6 — CORPUS-2.0 C: knowledge corpus server side
---

## changelog-en

### Corpus: the embedder key is kept for 60 s, and the step timings reach the info log (1.6.7 CORPUS-LATENCY, OPE-12272)

- A cold question needs the API key of the company's embedder secret. The secrets service resolved it
  on every such question: several reads and one write of a secret access event, and the reads queue
  behind a busy database. The resolved key is now kept in the board process for 60 s (setting
  `MYRMIDON_CORPUS_EMBED_KEY_CACHE_TTL_SEC`, `0` turns it off). The lookup of the secret row still runs
  on every question and the cache key holds the secret id and its latest version, so a rotated,
  replaced or deactivated secret is never served from an older entry. An embedder without the secret
  still answers `corpus_embedder_not_configured` at once.
- **Audit change, on purpose.** The access event of the embedder secret is written when the key is
  actually resolved, that is at most once per TTL and company (and once per secret version), not on every
  search. A reader of the access log sees about one `myrmidon-corpus` read a minute under load instead
  of one per cold question. Set the TTL to `0` to get one event per question again.
- The step timings of a search (`corpus search: handler step timings` of the REST route, the new
  `corpus mcp search: handler step timings` of the agent route, and `corpus search: embed and index
  timings`) went to the debug log. One search in N now writes them on the info log, so the split of a
  slow search can be read in production without debug (setting
  `MYRMIDON_CORPUS_STEP_TIMINGS_SAMPLE`, default 20; `1` is every search, `0` keeps them on debug). The
  other searches still write them on debug.

## changelog-ru

### Корпус: ключ эмбеддера хранится 60 с, тайминги шагов попадают в info-журнал (1.6.7 CORPUS-LATENCY, OPE-12272)

- Для холодного вопроса нужен API-ключ секрета эмбеддера компании. Сервис секретов разрешал его на
  каждый такой вопрос: несколько чтений и одна запись события доступа к секрету, причём чтения
  стоят в очереди за занятой базой. Теперь разрешённый ключ хранится в процессе доски 60 с (настройка
  `MYRMIDON_CORPUS_EMBED_KEY_CACHE_TTL_SEC`, `0` выключает). Поиск строки секрета по-прежнему выполняется
  на каждый вопрос, а ключ кэша содержит идентификатор секрета и его последнюю версию, поэтому
  ротированный, замещённый или отключённый секрет никогда не отдаётся из старой записи. Эмбеддер без
  секрета по-прежнему сразу отвечает `corpus_embedder_not_configured`.
- **Изменение аудита, осознанное.** Событие доступа к секрету эмбеддера пишется при фактическом
  разрешении ключа, то есть не чаще одного раза за TTL на компанию (и один раз на версию секрета), а не на
  каждый поиск. Читающий журнал доступа под нагрузкой видит примерно одно чтение `myrmidon-corpus` в минуту
  вместо одного на каждый холодный вопрос. TTL `0` возвращает одно событие на вопрос.
- Тайминги шагов поиска (`corpus search: handler step timings` маршрута REST, новая
  `corpus mcp search: handler step timings` маршрута агентов и `corpus search: embed and index timings`)
  шли в debug-журнал. Теперь один поиск из N пишет их в info-журнал, поэтому разложение медленного
  поиска видно на боевой доске без debug (настройка `MYRMIDON_CORPUS_STEP_TIMINGS_SAMPLE`, по умолчанию 20;
  `1` — каждый поиск, `0` — оставить в debug). Остальные поиски по-прежнему пишут их в debug.

## settings-en

| `MYRMIDON_CORPUS_EMBED_KEY_CACHE_TTL_SEC` | CORPUS-LATENCY (OPE-12272) | `60` | How many seconds the resolved API key of the company's embedder secret is reused, so a cold question does not go through the secrets service (several reads and one access-event write) every time. The lookup of the secret row runs on every question and the cache key holds the secret id and its latest version: a rotated, replaced or deactivated secret is never served from an older entry. The access event of the secret is written when the key is actually resolved, so at most once per TTL, company and secret version. The key stays in the memory of the board process only | `0` turns the cache off: every cold question resolves the key and writes an access event. Unset, empty, non-numeric or negative - the default. Above `86400` - `86400` |
| `MYRMIDON_CORPUS_STEP_TIMINGS_SAMPLE` | CORPUS-LATENCY (OPE-12272) | `20` | One search in N writes its step timings (`corpus search: handler step timings`, `corpus mcp search: handler step timings`, `corpus search: embed and index timings`) on the info log; the other searches write them on the debug log. The count is per process and per kind of line | `1` writes every search on info; `0` never writes on info (debug only, as before). Unset, empty, fractional, negative or non-numeric - the default. Above `1000000` - `1000000` |

## settings-ru

| `MYRMIDON_CORPUS_EMBED_KEY_CACHE_TTL_SEC` | CORPUS-LATENCY (OPE-12272) | `60` | Сколько секунд разрешённый API-ключ секрета эмбеддера компании используется повторно, чтобы холодный вопрос не ходил каждый раз через сервис секретов (несколько чтений и одна запись события доступа). Поиск строки секрета выполняется на каждый вопрос, а ключ кэша содержит идентификатор секрета и его последнюю версию: ротированный, замещённый или отключённый секрет никогда не отдаётся из старой записи. Событие доступа к секрету пишется при фактическом разрешении ключа, то есть не чаще одного раза за TTL, компанию и версию секрета. Ключ хранится только в памяти процесса доски | `0` выключает кэш: каждый холодный вопрос разрешает ключ и пишет событие доступа. Не задано, пусто, не число или отрицательное — значение по умолчанию. Больше `86400` — `86400` |
| `MYRMIDON_CORPUS_STEP_TIMINGS_SAMPLE` | CORPUS-LATENCY (OPE-12272) | `20` | Один поиск из N пишет тайминги своих шагов (`corpus search: handler step timings`, `corpus mcp search: handler step timings`, `corpus search: embed and index timings`) в info-журнал; остальные поиски пишут их в debug-журнал. Счётчик свой в каждом процессе и для каждого вида строки | `1` — каждый поиск пишет в info; `0` — в info не писать никогда (только debug, как раньше). Не задано, пусто, дробное, отрицательное или не число — значение по умолчанию. Больше `1000000` — `1000000` |
