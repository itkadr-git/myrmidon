## changelog-en

### cut-rc.mjs refuses a tag when release-task deliveries are missing from the branch (OPE-13001)

- New composition check in `scripts/myrmidon/release/cut-rc.mjs`: every
  `done` task of the release must have its delivery on the commit the tag
  points to. A merged PR counts when its merge commit is an ancestor of the
  release commit; a task without a merged PR counts when a commit on the
  branch mentions the task id in the subject (`OPE-NNNN` as a whole token,
  `OPE-100` does not match `OPE-10084`).
- A merged PR whose merge commit is missing from the release branch (a main
  fix that never landed there, a branch-foreign PR, or an unresolvable PR)
  is a hard refusal naming the task and the PR — never bypassable, same
  class as git/CI problems.
- A `done` task with no delivery trace at all is board-class: it rides the
  existing `--override --journal` path and is listed in the posted override
  record next to the board violations.
- Docs: `docs/myrmidon/releases/cut-rc.md` (EN + RU) documents the check,
  the hard/overridable split and the new test cases.

## changelog-ru

### cut-rc.mjs отказывает в теге, если поставки задач выпуска не на ветке (OPE-13001)

- Новая проверка состава в `scripts/myrmidon/release/cut-rc.mjs`: у каждой
  `done`-задачи выпуска поставка должна быть на коммите, куда встанет тег.
  Влитой PR засчитывается, когда его merge-коммит — предок релизного
  коммита; задача без влитого PR — когда на ветке есть коммит с
  идентификатором задачи в subject (`OPE-NNNN` целым токеном: `OPE-100` не
  матчит `OPE-10084`).
- Влитой PR, чей merge-коммит отсутствует на релизной ветке (фикс из main
  не доехал, PR чужой ветки или PR нечитаем) — жёсткий отказ с именем
  задачи и номера PR; обхода нет и не будет, как для git/CI.
- `done`-задача без всякого следа поставки — класс доски: идёт через
  существующий путь `--override --journal` и попадает в запись обхода на
  доске рядом с нарушениями доски.
- Доки: `docs/myrmidon/releases/cut-rc.md` (EN + RU) описывают проверку,
  деление на жёсткое/обходимое и новые тест-кейсы.
