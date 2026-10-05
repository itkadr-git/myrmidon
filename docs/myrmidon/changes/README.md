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
