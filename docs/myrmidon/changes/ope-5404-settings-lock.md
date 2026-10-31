---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### Concurrent instance-settings PATCHes no longer lose edits (PROCS-Q5)

- `updateGeneral` and `updateExperimental` read, merge and rewrite the whole
  settings document of the singleton `instance_settings` row. Two PATCHes that
  overlap in time could both read the same state, and the later commit wrote a
  merge of that stale read — the earlier edit disappeared without any error.
  Both paths now run as one database transaction that first takes the row with
  `SELECT … FOR UPDATE`, so concurrent PATCHes serialize on the row: order of
  application = order of commits, and every edit survives.
- The general and the experimental documents share the same row, so both write
  paths take the same lock: a general PATCH and an experimental PATCH can no
  longer clobber each other either. The first-writer insert also happens under
  the lock, so two brand-new instances cannot deadlock on the singleton insert.
- API behavior is unchanged: same routes, same validation, same response
  bodies, same preserved keys (maintenance, deploy jobs, access hub and the
  rest of the `preserve*` keys keep working — they now re-read the locked row).
  A single-process deployment with no overlapping PATCHes sees identical
  results, one write at a time.

## changelog-ru

### Параллельные PATCH настроек инстанса больше не теряют правки (PROCS-Q5)

- `updateGeneral` и `updateExperimental` читают, сливают и перезаписывают весь
  документ настроек единственной строки `instance_settings`. Два PATCHа,
  перекрывшиеся по времени, могли прочитать одно и то же состояние, и более
  поздний коммит писал слияние этого устаревшего чтения — более ранняя правка
  исчезала без ошибки. Оба пути теперь выполняются одной транзакцией
  базы данных, которая сначала берёт строку через `SELECT … FOR UPDATE`,
  поэтому параллельные PATCH сериализуются на строке: порядок применения
  равен порядку коммитов, и каждая правка сохраняется.
- Документы general и experimental делят одну строку, поэтому оба пути записи
  берут тот же замок: PATCH общих настроек и PATCH экспериментальных больше не
  затирают друг друга. Вставка первой строки тоже идёт под замком, поэтому
  два новых инстанса не могут впать в взаимную блокировку на вставке
  единственной строки.
- Поведение API не меняется: те же маршруты, та же валидация, те же ответы,
  те же сохраняемые ключи (maintenance, deploy jobs, access hub и остальные
  `preserve*`-ключи работают как раньше — под замком они перечитывают
  заблокированную строку). Развёртывание в один процесс без наложения PATCH
  даёт ровно тот же результат, по одной записи за раз.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| PROCS-Q5 | Оба пути записи настроек инстанса (`updateGeneral`, `updateExperimental`) вместо чтения-слияния-записи без блокировки выполняются транзакцией, берущей единственную строку `instance_settings` через `SELECT … FOR UPDATE` до чтения; вставка первой строки тоже идёт внутри той же транзакции, поэтому два первых писателя не блокируют друг друга на вставке. Семантика маршрутов, валидации и ответов не меняется | `server/src/services/instance-settings.ts` (метки `myrmidon(PROCS-Q5)` в обоих методах) | При мульти-процессной доске (BOARD-PROCESSES) параллельные PATCH одного документа теряли правки: победитель гонки читал устаревшее состояние и перезаписывал чужую правку. Раздел 4.5 проекта OPE-5394, тикет OPE-5404 | `server/src/__tests__/instance-settings-parallel-edit-lock.test.ts` (50 параллельных PATCH разных полей на embedded Postgres — все значения сохранены в ответах GET и в хранимой строке), существующие `instance-settings-service/operator-defaults/managed-overlay/litellm-fallback` тесты на фейковом db, который теперь поддерживает `transaction` | Никогда, наше поведение (гонка общая для вендорного кода). Снятие: вернуть прямое чтение/запись в обоих методах и удалить тест-файл и фрагмент | (этот PR) |
