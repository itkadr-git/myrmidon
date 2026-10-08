## changelog-en

### The release cut cannot forget the changelog version section (RELEASE-CUT-CHANGELOG)

- On 05.10 the `myr-v1.6.3` tag was pushed without a `## 1.6.3` section in
  `docs/myrmidon/CHANGELOG.md` — the notes still sat under `## Unreleased`
  and the release publish refused with "release body could not be built
  (missing notes)"; the release page was published by hand. The cut step now
  fails before that can happen again.
- `node scripts/myrmidon/release/collect-fragments.mjs --version X.Y.Z`
  verifies the collected changelogs before writing anything: a non-empty
  `## X.Y.Z` section and an empty `## Unreleased` / `## Без выпуска`, in EN
  and RU alike. A cut that would not pass CI fails locally.
- The new `--check` mode is the CI gate of a release tag:
  the `checks` lane of `myrmidon-ci-tag.yml` (the tag CI) fails
  a tag whose commit has no version section (or leftovers in the unreleased
  heading) — the tag is red before the image build and the release publish
  start.
- Guard tests: `scripts/myrmidon/release/collect-fragments.test.mjs` (the
  1.6.3 tag state fails, the 1.6.4 tag state passes, a non-empty unreleased
  section fails, an empty version section fails).

## changelog-ru

### Нарезка релиза не может забыть раздел версии в журнале (RELEASE-CUT-CHANGELOG)

- 05.10 тег `myr-v1.6.3` был поставлен без раздела `## 1.6.3` в
  `docs/myrmidon/CHANGELOG.md` — заметки остались под `## Unreleased`, и
  публикация релиза отказала с «release body could not be built (missing
  notes)»; страницу релиза опубликовали руками. Теперь шаг нарезки падает
  раньше, чем это может повториться.
- `node scripts/myrmidon/release/collect-fragments.mjs --version X.Y.Z`
  проверяет собранные журналы до записи файлов: непустой раздел `## X.Y.Z` и
  пустой `## Unreleased` / `## Без выпуска`, в EN и RU одинаково. Нарезка,
  которая не прошла бы CI, падает локально.
- Новый режим `--check` — CI-гейт тега релиза: lane `checks` в
  `myrmidon-ci-tag.yml` (CI тега) красит тег, на коммите которого
  нет раздела версии (или не пуст заголовок без выпуска) — тег красный до
  сборки образа и старта публикации релиза.
- Тест-сторож: `scripts/myrmidon/release/collect-fragments.test.mjs`
  (состояние тега 1.6.3 падает, состояние тега 1.6.4 проходит, непустой
  «без выпуска» падает, пустой раздел версии падает).
