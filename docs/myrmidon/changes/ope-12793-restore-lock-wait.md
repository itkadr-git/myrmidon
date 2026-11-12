---
settings-section: Track 2 — wake and run core
---

## changelog-en

### Workspace restore merge: no full target sha256 walk under the merge lock (OPE-12793)

- `mergeDirectoryWithBaseline` no longer captures a full `captureDirectorySnapshot` of the
  target directory while holding the directory-merge lock. Deletion safety is now checked
  per deleted path with the existing point comparison `directoryEntryMatchesBaseline`
  (one `lstat` + hash of the single file) — merge semantics are unchanged: a path absent
  from the source is removed from the target only when the target entry still matches the
  baseline snapshot. On the shared omp workspace (~27k files / 0.9 GB) this removes the
  3–10 minute full-directory sha256 walk that ran under the lock.
- The lock-wait timeout is split from the stale-lock threshold: `LOCK_STALE_MS` (30 s)
  remains only the "lock directory without a readable `owner.json` outlived this" marker,
  and a new `LOCK_WAIT_MS` (10 minutes) bounds how long an acquirer waits for a live
  holder. Restores no longer fail with `ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT` after 30 s
  while another restore's merge is legitimately running; the error code and message are
  unchanged.
- The source snapshot (`captureDirectorySnapshot(input.sourceDir)`) stays outside the
  lock, as before.

## changelog-ru

### Слияние восстановления рабочей копии: полный обход цели с sha256 под замком убран (OPE-12793)

- `mergeDirectoryWithBaseline` больше не делает полный `captureDirectorySnapshot` целевого
  каталога под замком слияния. Безопасность удаления теперь проверяется точечно для каждого
  удаляемого пути готовой функцией `directoryEntryMatchesBaseline` (один `lstat` + хэш
  одного файла) — семантика слияния не изменена: путь, отсутствующий в источнике, удаляется
  из цели только если запись в цели совпадает с базовым снимком. На общей рабочей копии omp
  (~27 тыс. файлов / 0,9 ГБ) это убирает 3–10-минутный обход всего каталога с sha256 под
  замком.
- Таймаут ожидания замка отделён от порога протухания: `LOCK_STALE_MS` (30 с) остаётся
  только признаком «замок без читаемого `owner.json` прожил дольше этого», а новый
  `LOCK_WAIT_MS` (10 минут) ограничивает, сколько ждать живого владельца. Восстановления
  больше не падают с `ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT` через 30 с, пока чужое слияние
  легитимно работает; код и текст ошибки не изменены.
- Снимок источника (`captureDirectorySnapshot(input.sourceDir)`) по-прежнему берётся вне
  замка, как раньше.

## settings-en

| `LOCK_WAIT_MS` (internal constant, not an environment variable) | OPE-12793 | `600000` | How long `acquireDirectoryMergeLock` waits for a live lock holder before throwing `ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT`. Split from `LOCK_STALE_MS` (30000 ms), which remains only the stale-marker for lock directories without a readable `owner.json`. Defined in `packages/adapter-utils/src/workspace-restore-merge.ts`; not configurable. | Fixed constant; raising it only delays the failure of a genuinely stuck holder |

## settings-ru

| `LOCK_WAIT_MS` (внутренняя константа, не переменная окружения) | OPE-12793 | `600000` | Сколько `acquireDirectoryMergeLock` ждёт живого владельца замка до выброса `ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT`. Отделена от `LOCK_STALE_MS` (30000 мс), который остаётся только порогом протухания для замков без читаемого `owner.json`. Определена в `packages/adapter-utils/src/workspace-restore-merge.ts`; не настраивается. | Фиксированная константа; увеличение лишь отодвигает падение при реально зависшем владельце |
