---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### Review-return loop finds the delivering task by PR url again (REVIEW-REWORK F-02)

- The url branch of the delivering-task lookup built `like $n%` — the wildcard
  sat outside the bound parameter, so Postgres answered every call with a
  syntax error and the review-return loop was dead for tasks whose PR is
  reachable only through a pull_request work-product url. The branch now
  matches the PR exactly: query/fragment parts are stripped and the url is
  anchored on `/github.com/<repo>/pull/<number>(/|$)`, so `/pull/12` and
  `/pull/12/files` match PR 12 while `/pull/123` no longer matches a search
  for 12. The metadata repo/number branch is unchanged.
- New guard: `scripts/myrmidon/ci/sql-template-lint.mjs` (CI step in the
  `checks` job) flags a `%` wildcard glued to a `sql` template interpolation
  edge — the exact bug class — across `server/src`; its node:test suite runs
  with the other script tests. Embedded-Postgres regression test:
  `server/src/myrmidon/review-rework/store.db.myrmidon.test.ts`.

## changelog-ru

### Петля возврата ревью снова находит задачу по url PR (REVIEW-REWORK F-02)

- Ветка поиска по url строила `like $n%`: wildcard оставался за пределами
  параметра, Postgres отвечал синтаксической ошибкой на каждый вызов, и петля
  возврата ревью была мертва для задач, чей PR виден только через url
  work-product типа pull_request. Ветка теперь совпадает точно: хвосты `#`/`?`
  отбрасываются, url привязан к `/github.com/<repo>/pull/<number>(/|$)` —
  `/pull/12` и `/pull/12/files` соответствуют PR 12, а `/pull/123` больше не
  подходит на поиск 12. Ветка по metadata repo/number не тронута.
- Новый сторож: `scripts/myrmidon/ci/sql-template-lint.mjs` (шаг в job
  `checks`) флагует `%`, приклеенный к краю интерполяции шаблона `sql`, — ровно
  этот класс ошибки — по всему `server/src`; сюита node:test идёт вместе с
  остальными тестами скриптов. Регрессия на embedded-Postgres:
  `server/src/myrmidon/review-rework/store.db.myrmidon.test.ts`.

## divergence

| REVIEW-REWORK | Ветка matching по url PR в `deliveringTaskAssignee` заменена на точную: `regexp_replace` отрезает `#`/`?`-хвост, url привязан к `/github.com/<repo>/pull/<n>(/\|$)`; поверх — CI-линт `scripts/myrmidon/ci/sql-template-lint.mjs` против `%` на краю `sql`-шаблонов | — (правка в fork-owned `server/src/myrmidon/review-rework/store.ts`) | шаблон `like ${"..."}%` оставлял wildcard вне параметра — Postgres отвечал `like $n%` синтаксической ошибкой на каждый вызов, петля возврата ревью была мертва | `server/src/myrmidon/review-rework/store.db.myrmidon.test.ts` (embedded PG) + `scripts/myrmidon/ci/sql-template-lint.test.mjs` (checks) | Никогда — наше поведение. Снятие: вернуть прежний like в `store.ts`, линт-шаг оставить как сторож класса ошибки | (этот PR) |
