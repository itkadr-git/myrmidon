---
settings-section: Track 5 — operations
---

## changelog-en

### An exhausted anonymous GitHub budget no longer blinds the board's authenticated reads (OPE-12397)

The board keeps one shared GitHub rate-limit state, and since 1.6.7-rc.12 the pull request and CI
readers send nothing to GitHub while that state says the budget is gone. A response of a small
bucket — the anonymous 60 requests an hour, the search 30 a minute — was recorded into the same
state, so one exhausted anonymous bucket marked every authenticated read rate limited: on 09.11 the
review's CI reads were blind for half an hour with 3740 of the installation's 5000 left. Responses
whose `x-ratelimit-limit` is below 1000 are now only counted and no longer change the shared state.

## changelog-ru

### Исчерпанный анонимный лимит GitHub больше не слепит авторизованные чтения доски (OPE-12397)

У доски одно общее состояние лимита GitHub, и с 1.6.7-rc.12 чтения PR и CI не ходят в GitHub, пока
оно говорит, что лимит исчерпан. Ответ малой корзины — анонимные 60 запросов в час, поиск 30 в
минуту — записывался в это же состояние, и один исчерпанный анонимный лимит помечал исчерпанными все
авторизованные чтения: 09.11 чтения CI ревью полчаса были слепыми при 3740 из 5000 оставшихся у
установки. Ответы с `x-ratelimit-limit` меньше 1000 теперь только учитываются и общее состояние не
меняют.
