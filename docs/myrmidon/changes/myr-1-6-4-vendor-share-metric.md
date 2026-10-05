---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### Vendor share metric: measuring files inherited from the vendor (VENDOR-SHARE-METRIC)

- `node scripts/myrmidon/vendor-share.mjs` measures how many tracked files the
  fork still inherits from the pinned vendor base commit
  (`scripts/myrmidon/vendor-base.txt`, refreshed per vendor import). A file is
  inherited when its path existed at the base (renames followed via
  `git diff -M`) and its line similarity against the base revision is at or
  above the threshold (`--threshold` flag → `MYRMIDON_VENDOR_SHARE_THRESHOLD`
  → built-in 0.5; the report names the source it used). Output is JSON or a
  short Markdown table; the release ritual records the number, replacing the
  hand audit.

## changelog-ru

### Метрика доли файлов, унаследованных от вендора (VENDOR-SHARE-METRIC)

- `node scripts/myrmidon/vendor-share.mjs` измеряет, сколько отслеживаемых
  файлов форк всё ещё наследует от зафиксированного базового коммита вендора
  (`scripts/myrmidon/vendor-base.txt`, обновляется на каждый перенос
  вендора). Файл считается унаследованным, если его путь был в базовом коммите
  (переименования учитываются через `git diff -M`) и доля совпадающих строк с
  базовой ревизией не ниже порога (флаг `--threshold` → env
  `MYRMIDON_VENDOR_SHARE_THRESHOLD` → встроенное 0.5; отчёт называет
  использованный источник). Вывод — JSON или короткая таблица Markdown;
  релизный ритуал фиксирует число вместо ручного аудита.

## divergence

| 1.6.2-VENDOR-SHARE-METRIC | Скрипт измерения доли унаследованных файлов и зафиксированная точка ответвления вендора. Файл считается унаследованным, если путь был в базовом коммите (переименование учитывается через `git diff -M`) и доля совпадающих строк не ниже порога (флаг `--threshold` → env `MYRMIDON_VENDOR_SHARE_THRESHOLD` → 0.5, источник значения печатается). Вывод — JSON и короткая таблица Markdown; исключения (lock-файлы, сгенерированное, сам файл базы и этот реестр) — списком в скрипте | нет изменённых файлов вендора; новые: `+ scripts/myrmidon/vendor-share.mjs`, `+ scripts/myrmidon/vendor-share.myrmidon.test.mjs`, `+ scripts/myrmidon/vendor-base.txt`, `+ docs/myrmidon/guides/vendor-share-analysis{,.ru}.md` | Правило продукта: доля вендорных файлов измеряется каждым релизом; раньше число бралось из ручного аудита | `scripts/myrmidon/vendor-share.myrmidon.test.mjs` (искусственный репозиторий: новый файл — не унаследован, нетронутый вендорский — унаследован, переписанный ниже порога — не унаследован, переименование через `git mv` — унаследован, lock-файл исключён; контракт CLI: JSON, Markdown, источник порога) | Никогда, наш инструмент. Снятие: удалить перечисленные файлы, строку `MYRMIDON_VENDOR_SHARE_THRESHOLD` в SETTINGS и этот раздел | (этот PR) |

## settings-en

| `MYRMIDON_VENDOR_SHARE_THRESHOLD` | VENDOR-SHARE-METRIC | unset (0.5) | Forces the line-similarity threshold of the vendor-share script: a file is inherited when the share of matching lines against the vendor base commit is at or above it. The `--threshold` flag wins over this variable, which wins over the built-in 0.5; the printed report shows `thresholdSource` | A value outside 0..1 fails the run with a clear message instead of silently falling back. Unset — the built-in 0.5 and a `default` source in the report |
