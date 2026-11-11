---
settings-section: Track 2 — wake and run core
---

## changelog-en

### Datastore-care audit: pg_settings unit factors, pgvector relkind filter, external backup coverage (1.6.6 DBC-4, OPE-12248)

- The audit report multiplies each `pg_settings` memory parameter by the byte
  factor of its `unit` column (B/kB/MB/GB/TB and the page units `8kB`/`16kB`),
  so `work_mem` 32768 kB is reported as 32.0 MiB with a true «attention»
  verdict against the 16 MiB threshold, and `shared_buffers` /
  `effective_cache_size` given in 8kB pages are shown in GiB instead of KiB.
- The pgvector column query filters `relkind = 'r'`, so an HNSW index record is
  no longer listed as an unindexed vector column («1 из 2 ok» → «1 из 1 ok»).
- New env `MYRMIDON_DATASTORE_CARE_BACKUP_EXTERNAL` (a coverage label such as
  `vm-pbs`): when set, the `backup-freshness` criterion reports the external
  coverage as healthy with the env as its source and does not scan the local
  backup directory.

## changelog-ru

### Аудит БД: unit-факторы pg_settings, фильтр relkind для pgvector, внешнее бэкап-покрытие (1.6.6 DBC-4, OPE-12248)

- Отчёт аудита умножает каждый байтовый параметр `pg_settings` на фактор
  колонки `unit` (B/kB/MB/GB/TB и постраничные `8kB`/`16kB`): `work_mem`
  32768 kB показывается как 32.0 MiB с честным вердиктом «внимание» против
  порога 16 МиБ, а `shared_buffers`/`effective_cache_size` в страницах 8kB —
  в ГиБ, а не в КиБ.
- Запрос pgvector-колонок фильтрует `relkind = 'r'`, поэтому запись HNSW-индекса
  больше не попадает в список колонок без индекса («1 из 2 ok» → «1 из 1 ok»).
- Новая переменная `MYRMIDON_DATASTORE_CARE_BACKUP_EXTERNAL` (метка покрытия,
  например `vm-pbs`): когда задана, критерий `backup-freshness` показывает
  внешнее покрытие как здоровое с источником env и не сканирует каталог
  локальных дампов.

## settings-en

| `MYRMIDON_DATASTORE_CARE_BACKUP_EXTERNAL` | DBC-4 | unset | External backup coverage label, such as `vm-pbs`. When set, the `backup-freshness` criterion reports the external coverage as healthy and does not scan the local backup directory | Unset — local backup files are used; blank values are ignored |

## settings-ru

| `MYRMIDON_DATASTORE_CARE_BACKUP_EXTERNAL` | DBC-4 | не задано | Метка внешнего бэкап-покрытия, например `vm-pbs`. Когда задана, критерий `backup-freshness` показывает внешнее покрытие как здоровое и не сканирует каталог локальных бэкапов | Не задано — используются локальные файлы бэкапов; пустые значения игнорируются |
