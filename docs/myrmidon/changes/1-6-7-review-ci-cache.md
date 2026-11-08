---
settings-section: Track 5 — operations
---

## changelog-en

### The review-stage CI reads are cached on the board, and nothing is asked while the rate limit is exhausted (OPE-12397)

The stranded-issue sweep asks GitHub for the CI of the open pull request of every review stage on
each heartbeat tick (30 s by default). Each ask was two to four `GET`s (the pull request, the
workflow listing, the `CI result` check, and in a repository without that check the checks of the
whole head), and none of them was remembered: about 2400 requests an hour were counted for the
`review-recovery` source out of the GitHub App's budget of 5000, after which the other readers of
GitHub (the CI gate of the review, the work-product refresh) went blind. The CI reads of the
review-stage recovery now keep a read cache per process:

- the head of a pull request is served from memory for `MYRMIDON_REVIEW_CI_PULL_CACHE_TTL_SEC`
  (default 60 s). The CI verdict of a head commit and the list of its failed checks are kept for
  the same time while the CI is pending (or the verdict is unknown without an error), and for
  `MYRMIDON_REVIEW_CI_COMPLETE_CACHE_TTL_SEC` (default 600 s) once the CI of the head is complete.
  `0` for both turns the cache off;
- an error (network, GitHub status, unreadable payload) is never stored, so the next sweep asks
  again;
- reads of the same head that run at the same time share one request;
- a result read with one token is never served to a caller with another;
- while the shared rate-limit state says the budget is gone, nothing is sent to GitHub (the
  workflow-listing probe included): the remembered result is returned, even an expired one, or
  "unknown" with the reason `...:skipped_rate_limited` and the time of the reset, which the review
  CI wait already uses to postpone the next check.

The cache keeps at most 5000 reads, the oldest leave first.

## changelog-ru

### Чтения CI в восстановлении стадии ревью кэшируются на доске, при исчерпанном лимите запросов не идут (OPE-12397)

Сторож зависших задач на каждом тике heartbeat (по умолчанию 30 с) спрашивает GitHub о CI
открытого PR каждой стадии ревью. Каждый такой вопрос был двумя-четырьмя `GET` (сам PR, список
workflow, проверка `CI result`, а в репозитории без неё — проверки всей головы), и ни один не
запоминался: на источник `review-recovery` приходилось около 2400 запросов в час из бюджета
GitHub App в 5000, после чего остальные читатели GitHub (CI-гейт ревью, обновление рабочих
продуктов) переставали видеть данные. Чтения CI восстановления стадии ревью теперь держат кэш
на процесс:

- голова PR отдаётся из памяти `MYRMIDON_REVIEW_CI_PULL_CACHE_TTL_SEC` секунд (по умолчанию 60).
  Вердикт CI коммита головы и список его упавших проверок держатся столько же, пока CI не
  завершён (или вердикт «неизвестно» без ошибки), и `MYRMIDON_REVIEW_CI_COMPLETE_CACHE_TTL_SEC`
  секунд (по умолчанию 600), когда CI головы завершён. `0` у обоих выключает кэш;
- ошибка (сеть, статус GitHub, нечитаемый ответ) не запоминается, поэтому следующий проход
  спрашивает заново;
- чтения одной головы, идущие одновременно, делят один запрос;
- результат, прочитанный с одним токеном, не отдаётся вызывающему с другим;
- пока общее состояние лимита говорит, что бюджет исчерпан, в GitHub ничего не отправляется (в том
  числе проверка списка workflow): возвращается запомненный результат, даже просроченный, либо
  «неизвестно» с причиной `...:skipped_rate_limited` и временем сброса, по которому ожидание CI
  ревью уже переносит следующую проверку.

В кэше не больше 5000 чтений, старейшие вытесняются первыми.

## settings-en

| `MYRMIDON_REVIEW_CI_COMPLETE_CACHE_TTL_SEC` | OPE-12397 | `600` | How many seconds the CI verdict of a head commit and the list of its failed checks are served from memory once the CI of the head is complete, before GitHub is asked again | `0` re-reads them as soon as the head TTL is over (the cache is off when `MYRMIDON_REVIEW_CI_PULL_CACHE_TTL_SEC` is `0` too: every read goes to GitHub, as before; the stop while the rate limit is exhausted stays); a non-numeric or negative value — the default |
| `MYRMIDON_REVIEW_CI_PULL_CACHE_TTL_SEC` | OPE-12397 | `60` | How many seconds the head of a pull request, and a CI verdict that is not final yet (pending, or unknown without an error), are served from memory before GitHub is asked again | `0` stops remembering the head and the pending verdicts (the cache is off when `MYRMIDON_REVIEW_CI_COMPLETE_CACHE_TTL_SEC` is `0` too); a non-numeric or negative value — the default |

## settings-ru

| `MYRMIDON_REVIEW_CI_COMPLETE_CACHE_TTL_SEC` | OPE-12397 | `600` | Сколько секунд вердикт CI коммита головы и список его упавших проверок отдаются из памяти, когда CI головы завершён, прежде чем снова спросить GitHub | `0` перечитывает их, как только истёк TTL головы (при `0` и у `MYRMIDON_REVIEW_CI_PULL_CACHE_TTL_SEC` кэш выключен: каждое чтение идёт в GitHub, как раньше; остановка при исчерпанном лимите остаётся); нечисловое или отрицательное значение — умолчание |
| `MYRMIDON_REVIEW_CI_PULL_CACHE_TTL_SEC` | OPE-12397 | `60` | Сколько секунд голова PR и ещё не окончательный вердикт CI (идёт или «неизвестно» без ошибки) отдаются из памяти, прежде чем снова спросить GitHub | `0` перестаёт запоминать голову и незавершённые вердикты (при `0` и у `MYRMIDON_REVIEW_CI_COMPLETE_CACHE_TTL_SEC` кэш выключен); нечисловое или отрицательное значение — умолчание |
