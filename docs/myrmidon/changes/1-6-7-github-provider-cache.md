---
settings-section: Track 5 — operations
---

## changelog-en

### GitHub pull request reads are cached on the board, and nothing is asked while the rate limit is exhausted (OPE-12397)

The board reads the same ~100 open pull requests from several places (review rework, merge
details, the CI resolver, the work-product refresh), and none of those reads carried an ETag, so
each was a full `GET` answered with 200: about 4-5 thousand requests an hour used up the GitHub
App's budget of 5000, after which the CI gate of the review could not see the checks. The
provider that reads pull requests and issues now keeps a read cache per process:

- an open object is served from memory for `MYRMIDON_GITHUB_OBJECT_CACHE_TTL_SEC` (default 120
  s; `0` turns the cache off); a merged, closed or not-found one for
  `MYRMIDON_GITHUB_OBJECT_TERMINAL_TTL_SEC` (default 1800 s). A "not found" that an anonymous
  read got, and a merged pull request whose merge commit the default branch does not reach yet,
  are not final: they are re-read after the short TTL;
- after the TTL the read is conditional (`If-None-Match`): a 304 costs no rate limit and renews
  the entry;
- reads of one object that run at the same time share one request;
- while the shared rate-limit state says the budget is gone, nothing is sent to GitHub: the cached
  read (even an expired one) is returned, or the same "rate limited" answer a 403 gives, with the
  time to come back; the extra `/compare` request of a merged pull request is skipped too;
- when the board merges a pull request itself, its cache entry is dropped.

The cache keeps at most 5000 objects, the oldest leave first. A read that a caller makes with an
ETag of its own is answered as before.

## changelog-ru

### Чтения PR из GitHub кэшируются на доске, при исчерпанном лимите запросов не идут (OPE-12397)

Доска читает одни и те же ~100 открытых PR из нескольких мест (доработка по ревью, данные о
влитии, резолвер CI, обновление рабочих продуктов), и ни одно из этих чтений не передавало ETag:
каждое было полным `GET` с ответом 200. Около 4-5 тысяч запросов в час выбирали бюджет GitHub App
в 5000, после чего CI-гейт ревью переставал видеть проверки. Провайдер, который читает PR и
issue, теперь держит кэш чтений на процесс:

- открытый объект отдаётся из памяти `MYRMIDON_GITHUB_OBJECT_CACHE_TTL_SEC` секунд (по умолчанию
  120; `0` выключает кэш), влитый, закрытый или «не найден» — `MYRMIDON_GITHUB_OBJECT_TERMINAL_TTL_SEC`
  (по умолчанию 1800). «Не найден», полученный анонимным чтением, и влитый PR, чей merge-коммит
  основная ветка ещё не содержит, не считаются окончательными: их перечитывают по короткому TTL;
- после TTL чтение условное (`If-None-Match`): ответ 304 не тратит лимит и продлевает запись;
- чтения одного объекта, идущие одновременно, делят один запрос;
- пока общее состояние лимита говорит, что бюджет исчерпан, в GitHub ничего не отправляется:
  возвращается закэшированное чтение (даже просроченное) либо тот же ответ «лимит исчерпан», что и
  при 403, со временем, когда зайти снова; дополнительный запрос `/compare` для влитого PR тоже
  пропускается;
- когда доска сама вливает PR, запись о нём в кэше сбрасывается.

В кэше не больше 5000 объектов, старейшие вытесняются первыми. Чтение, которое вызывающий делает со
своим ETag, отвечает как раньше.

## settings-en

| `MYRMIDON_GITHUB_OBJECT_CACHE_TTL_SEC` | OPE-12397 | `120` | How many seconds a read of an open pull request or issue is served from memory before GitHub is asked again (conditionally, with `If-None-Match`) | `0` turns the read cache off: every read goes to GitHub, as before (the stop while the rate limit is exhausted stays); a non-numeric or negative value — the default |
| `MYRMIDON_GITHUB_OBJECT_TERMINAL_TTL_SEC` | OPE-12397 | `1800` | The same for merged, closed and not-found objects, whose state rarely changes | `0` re-reads such objects (conditionally) on every read; a non-numeric or negative value — the default |

## settings-ru

| `MYRMIDON_GITHUB_OBJECT_CACHE_TTL_SEC` | OPE-12397 | `120` | Сколько секунд чтение открытого PR или issue отдаётся из памяти, прежде чем снова спросить GitHub (условным запросом, `If-None-Match`) | `0` выключает кэш чтений: каждое чтение идёт в GitHub, как раньше (остановка при исчерпанном лимите остаётся); нечисловое или отрицательное значение — умолчание |
| `MYRMIDON_GITHUB_OBJECT_TERMINAL_TTL_SEC` | OPE-12397 | `1800` | То же для влитых, закрытых и «не найденных» объектов, чьё состояние меняется редко | `0` перечитывает такие объекты (условным запросом) при каждом чтении; нечисловое или отрицательное значение — умолчание |
