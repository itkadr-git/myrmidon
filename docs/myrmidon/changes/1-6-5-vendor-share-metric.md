---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### Vendor-derived share in the release notes (1.6.5 VENDOR-SHARE-METRIC)

- Every release published by `publish-github-release.sh` now carries a
  `## Vendor-derived files` section: the share of files inherited from vendor
  code and its delta to the previous release —
  `Vendor-derived files: 6123 of 6812 (89.89%), Δ to myr-v1.6.4: +0.10 pp (+7 files)`.
  The numbers come from `scripts/myrmidon/vendor-share.mjs` (already in main),
  the previous line is parsed out of the previous release's own notes; a release
  published before the metric reads
  `нет данных (no vendor-share line in that release)`.
- The metric is advisory: when the share cannot be computed (no vendor base in
  the checkout, unreadable state file) the section says `не посчитано` with a
  warning and the release still goes out — a metric failure never fails a
  publish.
- `scripts/myrmidon/release/vendor-share-notes.mjs` (new) builds and parses the
  line; its unit contract is `vendor-share-notes.myrmidon.test.mjs` (11 tests),
  and the publisher integration lives in `release-publish.test.mjs` (3 more, the
  acceptance criteria of OPE-4152).

## changelog-ru

### Доля vendor-производных файлов в заметках релиза (1.6.5 VENDOR-SHARE-METRIC)

- Каждый релиз, который публикует `publish-github-release.sh`, теперь несёт
  раздел `## Vendor-derived files`: долю файлов, унаследованных от кода
  вендора, и её изменение к прошлому релизу —
  `Vendor-derived files: 6123 of 6812 (89.89%), Δ to myr-v1.6.4: +0.10 pp (+7 files)`.
  Числа даёт `scripts/myrmidon/vendor-share.mjs` (уже в main), прошлая строка
  разбирается из заметок прошлого релиза; релиз, вышедший до появления метрики,
  читается как `нет данных (no vendor-share line in that release)`.
- Метрика совещательная: когда долю посчитать нельзя (в клоне нет базы
  вендора, файл состояния нечитаем), раздел говорит `не посчитано` с
  предупреждением, а релиз всё равно публикуется — сбой метрики никогда не
  роняет публикацию.
- `scripts/myrmidon/release/vendor-share-notes.mjs` (новый) строит и разбирает
  строку; юнит-контракт — `vendor-share-notes.myrmidon.test.mjs` (11 тестов),
  интеграция с публикатором — в `release-publish.test.mjs` (ещё 3, критерии
  приёмки OPE-4152).
## settings-en

| `MYRMIDON_RELEASE_VENDOR_SHARE_STATE` | VENDOR-SHARE-METRIC | unset | Offline seam: a JSON share summary used instead of `vendor-share.mjs` when the release notes need the vendor-derived line (the same idea as `MYRMIDON_RELEASE_REGISTRY_STATE`); read by `scripts/myrmidon/release/vendor-share-notes.mjs`, never by the server | Unset — the share is computed by `vendor-share.mjs` against the checkout; the tests feed a file |
| `MYRMIDON_RELEASE_PREVIOUS_BODY` | VENDOR-SHARE-METRIC | unset | Offline seam: a file holding the previous release's notes, read for the previous vendor-share line instead of `gh release view <previous tag>` | Unset — the previous body is fetched from the previous release; a previous release without the line reads `нет данных` |

## settings-ru

| `MYRMIDON_RELEASE_VENDOR_SHARE_STATE` | VENDOR-SHARE-METRIC | не задано | Офлайн-шов: JSON-сводка доли вместо `vendor-share.mjs`, когда заметкам релиза нужна строка доли (та же идея, что у `MYRMIDON_RELEASE_REGISTRY_STATE`); читает `scripts/myrmidon/release/vendor-share-notes.mjs`, сервер — нет | Не задано — долю считает `vendor-share.mjs` по рабочей копии; тесты подают файл |
| `MYRMIDON_RELEASE_PREVIOUS_BODY` | VENDOR-SHARE-METRIC | не задано | Офлайн-шов: файл с заметками прошлого релиза — прошлая строка доли читается из него, а не из `gh release view <прошлый тег>` | Не задано — тело прошлого релиза берётся с GitHub; прошлый релиз без строки читается как `нет данных` |

## divergence

| VENDOR-SHARE-METRIC | Заметки релиза несут долю vendor-производных файлов и её дельту к прошлому релизу: `publish-github-release.sh` после сборки тела релиза дописывает раздел `## Vendor-derived files` строкой `Vendor-derived files: N of M (X %), Δ to <тег>: +d pp (+k files)`; числа даёт `vendor-share.mjs`, прошлая строка разбирается из заметок прошлого релиза, сбой подсчёта не ломает публикацию (`не посчитано` плюс предупреждение) | Файлы вендора не тронуты; наши: `scripts/myrmidon/release/publish-github-release.sh` (новый шаг 3b), + `scripts/myrmidon/release/vendor-share-notes.mjs` | Правило продукта: доля унаследованного кода измеряется каждым релизом, динамика видна в заметках (OPE-4152, 1.6.5) | `scripts/myrmidon/release/vendor-share-notes.myrmidon.test.mjs`; `scripts/myrmidon/release/release-publish.test.mjs` (раздел долей: строка с дельтой, «нет данных», «не посчитано») | Никогда, наше поведение. Снятие — убрать шаг 3b из публикатора, удалить модуль и тесты | (этот PR) |
