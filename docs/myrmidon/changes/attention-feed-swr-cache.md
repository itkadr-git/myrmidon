---
settings-section: Track 2 — wake and run core
---

## changelog-en

### Attention feed: stale-while-revalidate cache, one background rebuild (ATTENTION-FEED-SWR)

- The per-company attention feed snapshot is now served while it is stale. A
  snapshot older than the TTL is returned at once, and one background rebuild
  refreshes it; the reader does not wait for that rebuild. Parallel callers
  share the single rebuild of a cache key, so a poll from every open tab costs
  one feed build instead of one per tab.
- Past `2 × TTL` the read waits for a rebuild again. A reader therefore never
  receives a snapshot older than `2 × TTL`.
- The TTL default is now 60 seconds, the UI poll interval (was 45 seconds).
  `instance_settings.general.attentionFeedCacheTtlSeconds` still takes 0 to
  300, and `0` disables the cache.
- Invalidation stays TTL-based. The existing explicit invalidation (dismiss
  and snooze writes) additionally discards a rebuild that started before that
  write, so such a write is still visible on the next read.
- `generatedAt` now carries the build time of the served snapshot instead of the
  request time. A feed served from the cache therefore reports the age of its
  data rather than the age of the poll, and two reads of one snapshot return the
  same value.
- Unit tests with fake timers cover the three windows: fresh, stale (served at
  once, one rebuild for N parallel callers), and older than `2 × TTL` (waits).

## changelog-ru

### Лента «Внимание»: кэш со stale-while-revalidate и одна фоновая пересборка (ATTENTION-FEED-SWR)

- Снимок ленты «Внимание» по компании теперь отдаётся и после истечения TTL.
  Снимок старше TTL возвращается сразу, а одна фоновая пересборка обновляет
  его; читатель этой пересборки не ждёт. Параллельные вызовы делят одну
  пересборку на ключ кэша, поэтому опрос из всех открытых вкладок стоит одной
  сборки ленты, а не по сборке на вкладку.
- После `2 × TTL` чтение снова ждёт пересборку. Поэтому читатель никогда не
  получает снимок старше `2 × TTL`.
- Умолчание TTL теперь 60 секунд — интервал опроса интерфейса (было 45
  секунд). `instance_settings.general.attentionFeedCacheTtlSeconds` по-прежнему
  принимает 0–300, и `0` выключает кэш.
- Инвалидация остаётся по TTL. Существующая явная инвалидация (записи
  дисмисса и снуза) дополнительно отбрасывает пересборку, начавшуюся до этой
  записи, поэтому такая запись по-прежнему видна на следующем чтении.
- `generatedAt` теперь несёт время сборки отданного снимка, а не время запроса.
  Поэтому лента из кэша сообщает возраст своих данных, а не возраст опроса, и
  два чтения одного снимка возвращают одно и то же значение.
- Юнит-тесты с fake timers покрывают три окна: свежий снимок, устаревший
  (отдаётся сразу, одна пересборка при N параллельных вызовах) и старше
  `2 × TTL` (чтение ждёт).

## settings-en

| `attentionFeedCacheTtlSeconds` (`instance_settings.general`) | ATTENTION-FEED-SWR | `60` | Per-company in-process TTL of the built attention feed snapshot. A snapshot older than the TTL (and up to `2 × TTL`) is served at once while one background rebuild refreshes it | From 0 to 300; `0` — the cache is off. Missing or out of bounds — the default |

## settings-ru

| `attentionFeedCacheTtlSeconds` (`instance_settings.general`) | ATTENTION-FEED-SWR | `60` | Внутрипроцессный TTL собранного снимка ленты «Внимание» по компании. Снимок старше TTL (и до `2 × TTL`) отдаётся сразу, пока одна фоновая пересборка обновляет его | От 0 до 300; `0` — кэш выключен. Нет значения или вне диапазона — умолчание |