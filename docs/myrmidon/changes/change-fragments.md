---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### Registry entries as per-PR change fragments (CHANGE-FRAGMENTS)

- The shared registry documents — `docs/myrmidon/CHANGELOG(.ru).md`,
  `DIVERGENCE.md`, `SETTINGS(.ru).md` — are no longer appended to by hand.
  Every PR adds its entry as one file in `docs/myrmidon/changes/` (format and
  template: `docs/myrmidon/changes/README.md`), so two PRs with changelog
  entries merge back to back without conflicts instead of re-resolving the
  same append conflict in a circle.
- At release cut `node scripts/myrmidon/release/collect-fragments.mjs
  --version X.Y.Z` folds every fragment into the shared documents (changelog
  sections under a new `## X.Y.Z`, an empty `## Unreleased` /
  `## Без выпуска` left on top; divergence/settings table rows into the
  section the fragment names) and deletes the fragment files.
- A CI gate (`scripts/myrmidon/ci/change-fragments-gate.mjs`, running inside
  the existing node:test step of the checks job — no workflow change) refuses
  a PR that edits a shared registry document by hand and prints the hint:
  restore the file, add a fragment. The release-cut PR is recognized by the
  fragment deletions it carries and passes.

## changelog-ru

### Записи реестров отдельными файлами на PR (CHANGE-FRAGMENTS)

- Общие документы-реестры — `docs/myrmidon/CHANGELOG(.ru).md`,
  `DIVERGENCE.md`, `SETTINGS(.ru).md` — больше не дописываются руками. Каждый
  PR кладёт свою запись одним файлом в `docs/myrmidon/changes/` (формат и
  шаблон: `docs/myrmidon/changes/README.md`), и два PR с записями в журнал
  сливаются друг за другом без конфликтов вместо кругового ручного снятия
  одного и того же конфликта дописывания.
- При нарезке релиза `node scripts/myrmidon/release/collect-fragments.mjs
  --version X.Y.Z` складывает фрагменты в общие документы (разделы журнала под
  новый заголовок `## X.Y.Z`, пустой `## Unreleased` / `## Без выпуска`
  остаётся наверху; строки divergence/settings — в раздел, который называет
  фрагмент) и удаляет файлы фрагментов.
- CI-сторож (`scripts/myrmidon/ci/change-fragments-gate.mjs`, работает внутри
  существующего шага node:test job `checks` — workflow не менялся) отклоняет
  PR с ручной правкой общего документа и печатает подсказку: вернуть файл,
  добавить фрагмент. PR нарезки релиза сторож узнаёт по удалениям фрагментов
  и пропускает.

## divergence

| CHANGE-FRAGMENTS | Записи CHANGELOG/DIVERGENCE/SETTINGS — отдельными файлами `docs/myrmidon/changes/<ветка>.md` на PR; сборка фрагментов в общие документы скриптом при нарезке релиза; CI-сторож отклоняет ручную правку общих документов | Вендорские файлы не тронуты; + `scripts/myrmidon/release/collect-fragments.mjs`, `scripts/myrmidon/ci/change-fragments-gate{,-gate}.mjs`, `docs/myrmidon/changes/` | Каждое слияние делало остальные открытые PR конфликтными (все дописывают в конец CHANGELOG/DIVERGENCE), конфликты снимались вручную по кругу | `scripts/myrmidon/release/collect-fragments.test.mjs`, `scripts/myrmidon/ci/change-fragments-gate.test.mjs`, `scripts/myrmidon/ci/change-fragments-gate-selftest.test.mjs` | Никогда, наше поведение. Вендору нечего закрывать — это наш процесс | (этот PR) |
