## changelog-en

### cut-rc.mjs refuses a tag when release-task deliveries are missing from the branch (OPE-13001)

- New composition check in `scripts/myrmidon/release/cut-rc.mjs`: every
  `done` task of the release must have its delivery on the commit the tag
  points to. A merged PR counts when its merge commit is an ancestor of the
  release commit; a task without a merged PR counts when a commit on the
  branch mentions the task id in the subject (`OPE-NNNN` as a whole token,
  `OPE-100` does not match `OPE-10084`).
- Any composition gap (a merged PR missing from the branch, or a done task
  with no delivery trace at all) is a hard refusal naming the task and the
  missing delivery — never bypassable, blocking tag creation completely.
- Docs: `docs/myrmidon/releases/cut-rc.md` (EN + RU) documents the check,
  the hard refusal contract and the test cases.

## changelog-ru

### cut-rc.mjs отказывает в теге, если поставки задач выпуска не на ветке (OPE-13001)

- Новая проверка состава в `scripts/myrmidon/release/cut-rc.mjs`: у каждой
  `done`-задачи выпуска поставка должна быть на коммите, куда встанет тег.
  Влитой PR засчитывается, когда его merge-коммит — предок релизного
  коммита; задача без влитого PR — когда на ветке есть коммит с
  идентификатором задачи в subject (`OPE-NNNN` целым токеном: `OPE-100` не
  матчит `OPE-10084`).
- Любое расхождение по составу (влитой PR отсутствует на ветке или
  `done`-задача без следов поставки) — жёсткий отказ с именем задачи и
  пропуска; блокирует создание тега и не обходится через override.
- Доки: `docs/myrmidon/releases/cut-rc.md` (EN + RU) описывают проверку,
  жёсткую блокировку тега и тест-кейсы.
