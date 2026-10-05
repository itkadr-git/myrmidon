# Change fragments (one file per PR)

> Русская версия ниже / Russian version below.

Every PR that changes behaviour ships its registry entry as **one file in
this directory**, not as an edit of the shared documents. The shared documents
— `CHANGELOG.md` / `CHANGELOG.ru.md`, `DIVERGENCE.md`, `SETTINGS.md` /
`SETTINGS.ru.md` — are assembled from these fragments at release cut by
`scripts/myrmidon/release/collect-fragments.mjs` and are **never edited by
hand in a PR** (the CI gate
`scripts/myrmidon/ci/change-fragments-gate.mjs` refuses such edits). Two PRs
with changelog entries then merge one after another without conflicts: each
adds its own file.

## File name

`<branch-slug>.md`, lowercase Latin with hyphens, e.g.
`claude-t2-p1-leases.md` → `t2-p1-leases.md`, `myr-change-fragments.md` →
`change-fragments.md`. One PR — one fragment. Two PRs extending the same
feature each add their own fragment file.

## Format

Optional front matter (needed only when the matching section is present),
then any subset of the five sections:

```markdown
---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### Title as it should appear in the changelog (FEATURE-ID)

- Bullet points of the entry, markdown. Headings inside a section start at
  `###` — the collector places the block under the version heading.

## changelog-ru

### Заголовок (FEATURE-ID)

- The same entry in Russian. User-visible entries ship in both languages.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
| ...one full DIVERGENCE.md table row per line... |

## settings-en

| `MYRMIDON_<AREA>_<NAME>` | FEATURE-ID | default | what it does | how to disable |

## settings-ru

| `MYRMIDON_<AREA>_<NAME>` | FEATURE-ID | умолчание | что делает | как выключить |
```

Rules:

- Every section is optional. A docs-only fix usually carries `changelog-en` +
  `changelog-ru`; a pure refactor may carry nothing but a changelog note, or
  — with nothing user-visible and no registry rows — no fragment at all. A
  fragment with no content section is an error.
- `divergence` / `settings-*` sections contain **only table rows** (lines
  starting with `|`). The collector appends them to the section named by the
  front-matter key: `divergence-section` is the `## …` heading of
  DIVERGENCE.md (e.g. `Трек 5 — эксплуатация`), `settings-section` is the
  `## …` heading of SETTINGS.md and SETTINGS.ru.md (the RU file reuses the EN
  headings, e.g. `Track 5 — operations`). A section present without its
  front-matter key is an error; an unknown heading name fails the release
  collect loudly, listing the available sections.
- Table rows follow the same pipe-escaping rule as the shared documents:
  `a \|\| b` inside a cell.
- The collector validates the fragment; the PR author can run it any time:
  `node scripts/myrmidon/release/collect-fragments.mjs --version 0.0.0 --dry-run`.

## Extended sections: new sections, prose, row replacement

The five basic sections only append. Three more families cover what a PR
otherwise has to write into the shared documents by hand. Each exists per
document — `divergence-…` (DIVERGENCE.md), `settings-en-…` (SETTINGS.md),
`settings-ru-…` (SETTINGS.ru.md) — and **may repeat** in one fragment. A block
may start with `<!-- key: value -->` directive lines.

```markdown
## settings-en-new

<!-- after: Track 5 — operations -->
### 1.7 — NEW AREA

Prose of the new section, then its table, as in the shared document.

#### Sub heading

## settings-en-append

<!-- section: Track 6 — models -->
Prose (or prose plus a table) added at the end of that existing section.

## divergence-replace

<!-- section: EXTCASE-B — мост браузера расширению клиента -->
<!-- occurrence: 2 -->
| ID | the full rewritten row | … |
```

- `…-new` — one or more new `##` sections. Write them with **`###`** headings
  (the collector promotes every heading level by one, code fences excepted);
  the block must start with a `### …` line. `<!-- after: Heading -->` puts the
  section after that existing section (and after sections other fragments put
  there earlier); without a directive it goes to the end of the document.
  `<!-- after-line: exact line -->` is the fallback anchor.
- `…-append` — text added to an existing section: `<!-- section: Heading -->`
  appends at the end of the section; `<!-- after-line: exact line -->` inserts
  right after that one (unique) line. A block made only of table rows (needs
  `section`) follows the table-row rule: after the last row of the section.
- `…-replace` — table rows that **replace** the existing row with the same
  first cell (the ID / variable name). The first cell must be unique in the
  document, or the block names `<!-- section: Heading -->`.
- `<!-- occurrence: N -->` (with `after` / `section`) picks the N-th section
  when a heading is not unique; without it an ambiguous heading is an error.
  Unknown headings and anchors fail the release collect loudly, listing the
  sections the document has.
- A fragment can also carry a changelog block with any prose: a `### Title`
  block in `changelog-en` / `changelog-ru` is copied as is.

Ordering is deterministic: fragments are applied in plain code-unit order of
their file names (uppercase before lowercase), whatever order the file system
lists them; inside one fragment the passes run replace → rows → append → new;
two new sections with the same anchor keep the order of their fragments.

## Converting an old branch (converter)

A branch that already edited the shared documents is converted by

```sh
node scripts/myrmidon/release/fragments-from-diff.mjs --slug <slug> --revert
```

(`--base origin/main --head HEAD` are the defaults). It reads the diff
`merge-base..head` of the five documents, writes
`docs/myrmidon/changes/<slug>.md` and with `--revert` restores the documents to
`--base`. Supported edits: whole `### …` blocks in the changelogs; rows added
to a table, whole new `##` sections, prose added inside a section, and one
existing row rewritten in DIVERGENCE/SETTINGS. Anything else (an existing line
edited or deleted, a bullet added to an existing changelog entry) is listed as
`unsupported` and **nothing is written**. The fragment is assembled onto the
base documents in memory and compared with the branch's own result:
`exact`, `blank` (same up to blank lines), or `moved` (same lines, the
fragment lands at the documented place instead of the original spot — a
warning); a real difference stops the run (`--force` overrides, `--dry-run`
prints the fragment, `--no-verify` skips the comparison). A changelog block
that sat in an already released section lands in the next release — the
converter warns.

## Release cut

Whoever cuts `myr-vX.Y.Z` runs, in one PR (branch `release/X.Y.Z`):

```sh
node scripts/myrmidon/release/collect-fragments.mjs --version X.Y.Z
```

The script folds every fragment into the shared documents — changelog blocks
under a new `## X.Y.Z` / `## Без выпуска` → `## X.Y.Z` heading (an empty
`## Unreleased` / `## Без выпуска` stays on top for the next cycle),
divergence/settings rows into their named sections — and deletes the fragment
files. The release-cut PR is the only PR that legitimately edits the shared
documents; the CI gate recognizes it by the fragment deletions it carries.

---

# Фрагменты изменений (один файл на PR)

Каждый PR, меняющий поведение, кладёт запись реестров **одним файлом в этот
каталог**, а не правкой общих документов. Общие документы — `CHANGELOG.md` /
`CHANGELOG.ru.md`, `DIVERGENCE.md`, `SETTINGS.md` / `SETTINGS.ru.md` — собираются
из фрагментов при нарезке релиза скриптом
`scripts/myrmidon/release/collect-fragments.mjs` и **вручную в PR не правятся**
(CI-сторож `scripts/myrmidon/ci/change-fragments-gate.mjs` такие правки
отклоняет). Два PR с записями в журнал сливаются друг за другом без
конфликтов: каждый добавляет свой файл.

Имя файла — `<слаг-ветки>.md` (латиница, дефисы). Один PR — один фрагмент.
Формат и шаблон — в английской части выше. Раздел `divergence` содержит строки
таблицы DIVERGENCE.md и требует ключа `divergence-section` (название раздела,
например `Трек 5 — эксплуатация`); разделы `settings-en`/`settings-ru` — строки
таблиц SETTINGS.md / SETTINGS.ru.md и ключ `settings-section` (например,
`Track 5 — operations`). При нарезке релиза
`node scripts/myrmidon/release/collect-fragments.mjs --version X.Y.Z` складывает
фрагменты в общие документы (под новый заголовок `## X.Y.Z`; пустой
`## Unreleased` / `## Без выпуска` остаётся наверху для следующего цикла) и
удаляет файлы фрагментов. PR нарезки — единственный, кто правит общие
документы; сторож узнаёт его по удалениям фрагментов.


## Расширенные разделы: новые секции, проза, замена строк

Пять базовых разделов только дописывают. Три семейства покрывают то, что PR
иначе пришлось бы писать в общие документы руками. Каждое есть для каждого
документа — `divergence-…` (DIVERGENCE.md), `settings-en-…` (SETTINGS.md),
`settings-ru-…` (SETTINGS.ru.md) — и **может повторяться** во фрагменте. Блок
может начинаться со строк-директив `<!-- ключ: значение -->`.

- `…-new` — одна или несколько новых секций `##`. Пишутся с заголовками
  **`###`** (сборщик поднимает каждый уровень заголовка на единицу, кроме
  кодовых блоков); блок обязан начинаться со строки `### …`.
  `<!-- after: Заголовок -->` ставит секцию после указанной существующей
  (и после секций, которые туда уже поставили другие фрагменты); без директивы —
  в конец документа. Запасной якорь — `<!-- after-line: точная строка -->`.
- `…-append` — текст в существующую секцию: `<!-- section: Заголовок -->` —
  в конец секции; `<!-- after-line: точная строка -->` — сразу после этой
  (единственной) строки. Блок из одних строк таблицы (нужен `section`)
  работает по правилу строк таблицы: после последней строки секции.
- `…-replace` — строки таблицы, **заменяющие** существующую строку с той же
  первой ячейкой (ID / имя переменной). Первая ячейка должна быть уникальна в
  документе, иначе блок называет `<!-- section: Заголовок -->`.
- `<!-- occurrence: N -->` (вместе с `after` / `section`) выбирает N-ю секцию,
  если заголовок не уникален; без него неоднозначный заголовок — ошибка.
  Неизвестные заголовки и якоря роняют сборку релиза с перечнем секций.
- Во фрагменте можно положить и журнал с любой прозой: блок `### Заголовок` в
  `changelog-en` / `changelog-ru` копируется как есть.

Порядок детерминирован: фрагменты применяются по именам файлов в простом
порядке кодовых единиц (заглавные раньше строчных), независимо от порядка,
которым файловая система их отдаёт; внутри фрагмента проходы идут так: replace
→ строки → append → new; две новые секции с одним якорем сохраняют порядок
своих фрагментов.

### Перенос старой ветки (конвертер)

Ветку, которая уже правила общие документы, переводит

```sh
node scripts/myrmidon/release/fragments-from-diff.mjs --slug <слаг> --revert
```

(по умолчанию `--base origin/main --head HEAD`). Он читает diff
`merge-base..head` пяти документов, пишет `docs/myrmidon/changes/<слаг>.md`, а
с `--revert` возвращает документы к `--base`. Поддержаны: целые блоки `### …` в
журналах; добавленные строки таблицы, целые новые секции `##`, проза внутри
секции и одна переписанная строка в DIVERGENCE/SETTINGS. Всё остальное
(правка или удаление существующей строки, пункт, добавленный в существующую
запись журнала) выводится как `unsupported`, и **ничего не пишется**. Фрагмент
собирается на базовые документы в памяти и сверяется с результатом ветки:
`exact`, `blank` (то же с точностью до пустых строк), `moved` (те же строки,
фрагмент ложится в положенное место, а не на прежнее — предупреждение);
реальное расхождение останавливает запуск (`--force` — записать всё равно,
`--dry-run` — напечатать фрагмент, `--no-verify` — без сверки). Блок журнала,
стоявший в уже вышедшем разделе, попадёт в следующий выпуск — конвертер
предупреждает.
