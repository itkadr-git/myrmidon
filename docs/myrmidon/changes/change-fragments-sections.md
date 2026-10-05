## changelog-en

### Change fragments: new sections, prose, row replacement and a converter (CHANGE-FRAGMENTS)

- A fragment can now carry what used to force a hand edit of the shared
  registry documents: whole new `##` sections for DIVERGENCE.md / SETTINGS.md /
  SETTINGS.ru.md (`…-new`), prose or tables inside an existing section
  (`…-append`) and rewritten table rows (`…-replace`), each with an anchor by
  section heading, occurrence number or exact line. Fragments are applied in
  plain code-unit order of their file names, so the assembled documents do not
  depend on how the file system lists them.
- `scripts/myrmidon/release/fragments-from-diff.mjs` converts a branch that
  already edited the shared documents: it writes the equivalent fragment,
  reverts the documents, and checks that assembling the fragment reproduces
  the branch's own edit (a mismatch stops the run). Format and usage:
  `docs/myrmidon/changes/README.md`.

## changelog-ru

### Фрагменты изменений: новые секции, проза, замена строк и конвертер (CHANGE-FRAGMENTS)

- Фрагмент теперь может нести то, ради чего приходилось править общие
  документы-реестры руками: целые новые секции `##` для DIVERGENCE.md /
  SETTINGS.md / SETTINGS.ru.md (`…-new`), прозу или таблицы внутри существующей
  секции (`…-append`) и переписанные строки таблиц (`…-replace`) с якорем по
  заголовку секции, номеру вхождения или точной строке. Фрагменты применяются в
  простом порядке кодовых единиц имён файлов, поэтому собранные документы не
  зависят от порядка, в котором файловая система отдаёт файлы.
- `scripts/myrmidon/release/fragments-from-diff.mjs` переводит ветку, уже
  правившую общие документы: пишет эквивалентный фрагмент, возвращает документы
  и проверяет, что сборка фрагмента воспроизводит собственную правку ветки
  (расхождение останавливает запуск). Формат и использование:
  `docs/myrmidon/changes/README.md`.
