---
settings-section: Track 5 — operations
---

## changelog-en

### OPE-12335: deploy.sh exclusive deploy lock protection against parallel runs

- Added exclusive deploy locking (`flock`) at the beginning of `scripts/myrmidon/deploy/deploy.sh` via `acquire_deploy_lock` in `lib.sh`.
- Prevents concurrent deployments from overlapping and racing during maintenance and container recreation.
- Supports `MYRMIDON_DEPLOY_LOCK_FILE` (defaults to `$STATE_DIR/deploy.lock` or `/var/lib/myrmidon/deploy/deploy.lock`) and `MYRMIDON_DEPLOY_LOCK_WAIT_SEC` (defaults to 0).
- If the lock is held, exits immediately with code 42 and prints the holder's PID, start time, and version (or waits if `MYRMIDON_DEPLOY_LOCK_WAIT_SEC` > 0).
- Dry-run mode warns if the lock is held without acquiring it.
- Automatically releases and cleans up the lock file via a trap on EXIT, INT, and TERM.

## changelog-ru

### OPE-12335: защита deploy.sh от параллельного запуска (замок выката)

- В начале `scripts/myrmidon/deploy/deploy.sh` добавлен эксклюзивный замок (`flock`) через `acquire_deploy_lock` в `lib.sh`.
- Защищает от наложения двух параллельных выкатов, гонок в режиме обслуживания и пересоздания контейнеров.
- Поддерживает настройки `MYRMIDON_DEPLOY_LOCK_FILE` (по умолчанию `$STATE_DIR/deploy.lock` или `/var/lib/myrmidon/deploy/deploy.lock`) и `MYRMIDON_DEPLOY_LOCK_WAIT_SEC` (по умолчанию 0).
- При занятом замке завершается с кодом 42 и выводит PID, время старта и версию процесса, держащего замок (или ожидает при `MYRMIDON_DEPLOY_LOCK_WAIT_SEC` > 0).
- Режим `--dry-run` предупреждает, если замок занят, но не пытается его захватить.
- Замок снимается и файл очищается по trap на EXIT, INT и TERM.

## settings-en

| `MYRMIDON_DEPLOY_LOCK_FILE` | DEPLOY-LOCK | unset | Path to the exclusive deploy lock file used by deploy.sh to prevent concurrent deployments (defaults to `$STATE_DIR/deploy.lock` or `/var/lib/myrmidon/deploy/deploy.lock`) | Unset — uses the state directory default |
| `MYRMIDON_DEPLOY_LOCK_WAIT_SEC` | DEPLOY-LOCK | `0` | How many seconds to wait for the deploy lock if another deploy is currently running, before failing with exit code 42 and printing the holder's PID, start time, and version | `0` — fail immediately if locked |

## settings-ru

| `MYRMIDON_DEPLOY_LOCK_FILE` | DEPLOY-LOCK | не задан | Путь к файлу эксклюзивного замка выката, используемому `deploy.sh` для предотвращения параллельных запусков (по умолчанию `$STATE_DIR/deploy.lock` или `/var/lib/myrmidon/deploy/deploy.lock`) | Не задан — используется значение по умолчанию в каталоге состояния |
| `MYRMIDON_DEPLOY_LOCK_WAIT_SEC` | DEPLOY-LOCK | `0` | Сколько секунд ждать освобождения замка выката, если другой выкат уже идёт, перед ошибкой с кодом выхода 42 и выводом PID, времени старта и версии процесса, держащего замок | `0` — завершаться с ошибкой сразу, если замок занят |
