---
settings-section: Track 5 — operations
---

## changelog-en

### Backup free-space floor is overridable (OPE-12551)

- Planned database backups refuse to start when the backup directory has less free space than the floor (default 6 GiB) and log `Skipping database backup`, so a dump can never fill the disk of a disk-tight runner.
- The floor is configurable via `MYRMIDON_BACKUP_MIN_FREE_BYTES` (bytes); `0` disables the gate, invalid or negative values keep the 6 GiB default. Legacy alias: `PAPERCLIP_BACKUP_MIN_FREE_BYTES`.

## changelog-ru

### Настраиваемая нижняя граница свободного места для бэкапа (OPE-12551)

- Плановый бэкап базы данных отказывается стартовать, если в каталоге бэкапа меньше свободного места, чем нижняя граница (по умолчанию 6 GiB), и пишет `Skipping database backup`, — дамп не может заполнить диск на стенде с тесным диском.
- Граница задаётся переменной `MYRMIDON_BACKUP_MIN_FREE_BYTES` (в байтах); `0` отключает гейт, нечисловое или отрицательное значение оставляет умолчание 6 GiB. Устаревший псевдоним: `PAPERCLIP_BACKUP_MIN_FREE_BYTES`.

## settings-en

| `MYRMIDON_BACKUP_MIN_FREE_BYTES` | SHARED-PG-BACKUP | `6442450944` (6 GiB) | Minimum free space (bytes) required in the backup directory: below it `runDatabaseBackup` refuses to start a dump (`Skipping database backup`); disk-tight runners and tests lower the threshold; `0` disables the gate | non-numeric or negative value keeps the 6 GiB default |

## settings-ru

| `MYRMIDON_BACKUP_MIN_FREE_BYTES` | SHARED-PG-BACKUP | `6442450944` (6 GiB) | Нижняя граница свободного места (в байтах) в каталоге бэкапа: при меньшем объёме `runDatabaseBackup` отказывается стартовать дамп (`Skipping database backup`); тесты и стенды с тесными дисками снижают порог; `0` отключает гейт | не число/отрицательное — значение по умолчанию 6 GiB |
