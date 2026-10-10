---
divergence-section: Трек 2 — ядро побудок и прогонов
settings-section: Track 2 — wake and run core
---

## changelog-en
### Keep only the last verified database backup (1.6.5 BACKUP-KEEP-LAST)

- `instance_settings.general.backupRetention.keepLastOnly` (default off): when
  on, a backup run ignores the tier presets — after the new dump is written it
  is stream-verified (full gunzip pass plus a dump-completion marker in the
  decompressed tail, holding only a 64 KiB buffer) and only then every
  previous `<prefix>-*` backup is deleted.
- A new dump failing verification is deleted on the spot, all previous backups
  kept: the mode can never trade a good old backup for a bad new one. Both
  engines (pg_dump and the JavaScript logical dump) verify and prune
  identically; a verification failure is never retried on the other engine.
- Independent of the mode, pruning first removes orphaned unfinished `.sql`
  files older than one hour (leftovers of interrupted runs); the live run's
  own writer is never touched.
- Additive: payloads written before 1.6.5 parse unchanged. The UI toggle ships
  separately; server contract `keepLastOnly` on
  `PATCH /api/instance/settings/general`.
## changelog-ru

### Режим «хранить только последний проверенный бэкап БД» (1.6.5 BACKUP-KEEP-LAST)

- В политике хранения бэкапов появился необязательный флаг `keepLastOnly`
  (`instance_settings.general.backupRetention.keepLastOnly`, по умолчанию
  выключен). Когда он включён, прогон бэкапа игнорирует пресеты тиров
  daily/weekly/monthly: после записи нового дампа
  `<prefix>-<timestamp>.sql.gz` он потоково проверяется (полный прогон
  gunzip плюс проверка, что распакованный хвост несёт маркер завершения
  дампа — закрывающий `COMMIT;` JavaScript-дампа или трейлер
  `-- PostgreSQL database dump complete`, которым заканчивается
  `pg_dump --format=plain` (OPE-4832)), и только затем все прежние файлы
  `<prefix>-*` в каталоге бэкапов удаляются. Проверка не материализует
  дамп — держится хвостовой буфер 64 КиБ, поэтому многогигабайтные бэкапы
  проверяются потоково.
- Новый дамп, не прошедший проверку, удаляется сразу, все прежние бэкапы
  остаются нетронутыми, а прогон завершается ошибкой с причиной — режим не
  может променять хороший старый бэкап на битый новый.
- Режим работает на обоих движках: путь pg_dump и путь логического дампа на
  JavaScript проверяют и чистят одинаково. Провал верификации не
  повторяется на другом движке (ошибка `BackupVerificationError` — прогон
  падает громко); фолбэк на JavaScript после genuine-отказа процесса
  pg_dump открывает новый писатель дампа вместо записи в уже закрытый
  (OPE-4832).
- Независимо от режима проход чистки теперь сначала удаляет недописанные
  сироты `*.sql` старше одного часа — остатки прерванных прогонов (дамп
  пишется как `.sql`, затем жмётся в `.gz`; при падении `.sql` остаётся).
  Собственный недописанный `.sql` живого прогона не задевается (отсечка
  строго старше часа, писатель держит mtime свежим), удалённые сироты
  считаются в `prunedCount` прогона.
- Настройка аддитивна: payload'ы настроек, сохранённые до 1.6.5, парсятся
  без изменений, отсутствующий флаг оставляет прежнее поведение тиров.
  Переключатель в UI выходит отдельно (часть B); серверный контракт —
  `{"backupRetention": {"dailyDays": 3, "weeklyWeeks": 1, "monthlyMonths": 1, "keepLastOnly": true}}`
  на `PATCH /api/instance/settings/general`.

## divergence

| 1.6.5-BACKUP-KEEP-LAST | Политика хранения бэкапов БД получила необязательный флаг `keepLastOnly` (`instance_settings.general.backupRetention.keepLastOnly`): при `true` прогон после записи нового дампа потоково его верифицирует (полный gunzip + наличие маркера завершения дампа в хвосте — `COMMIT;` JavaScript-дампа или трейлер `-- PostgreSQL database dump complete` у pg_dump, буфер хвоста 64 КиБ) и только после успеха удаляет все прочие файлы `<prefix>-*.sql.gz`/`<prefix>-*.sql`; пресеты тиров при этом игнорируются. Битый новый дамп удаляется, старые бэкапы сохраняются, прогон завершается ошибкой с причиной (`BackupVerificationError`, без фолбэка на другой движок; фолбэк javascript после отказа процесса pg_dump пишет в новый писатель). Верификация работает на обоих движках (pg_dump и javascript). Независимо от флага прунинг сначала удаляет недописанные сироты `*.sql` старше 1 часа (константа `BACKUP_ORPHAN_SQL_MAX_AGE_MS`), считая их в `prunedCount`. Поле аддитивно: старые payload'ы парсятся без изменений | `packages/shared/src/types/instance.ts`, `packages/shared/src/validators/instance.ts`, `packages/db/src/backup-lib.ts` (все правки помечены `myrmidon(BACKUP-KEEP-LAST)`), тесты `packages/db/src/backup-keep-last.myrmidon.test.ts` | Решение владельца 05.10 (зонтик 1.6.5): операторам нужен режим «только последний бэкап» для инстансов с дорогим диском, при этом битый дамп не должен вытеснять годный старый | `packages/db/src/backup-keep-last.myrmidon.test.ts` | Никогда, наше поведение: режим держится на флаге `keepLastOnly` в политике хранения (по умолчанию выключен, снятие флага возвращает прежнее поведение тиров); если вендор сам получит режим «только последний бэкап» с верификацией — удалить куски `myrmidon(BACKUP-KEEP-LAST)` и переписать тест-сторож на поведение вендора | (этот PR) |

## settings-en

| `backupRetention.keepLastOnly` | 1.6.5-BACKUP-KEEP-LAST | absent (off) | Keep-only-the-last mode of the database backup retention. When `true`, a backup run ignores the daily/weekly/monthly tier presets: after writing the new `<prefix>-<timestamp>.sql.gz` dump it stream-verifies it (full gunzip pass plus a dump completion marker on the decompressed tail — the JavaScript dump's closing `COMMIT;` or the pg_dump trailer `-- PostgreSQL database dump complete`, 64 KiB tail buffer) and only then deletes every other `<prefix>-*` backup file in the backup directory. A new dump that fails verification is deleted, previous backups are kept and the run fails with the reason (`BackupVerificationError`, never retried on the other engine; a JavaScript fallback after a pg_dump child failure writes into a fresh dump writer). Independently of the flag, unfinished plain `.sql` leftovers older than 1 hour (orphans of interrupted runs) are pruned first and counted in `prunedCount` | Absent or `false` — the tiered retention works as before. The flag rides the existing `backupRetention` object on `PATCH /api/instance/settings/general`; payloads saved before 1.6.5 parse unchanged |
