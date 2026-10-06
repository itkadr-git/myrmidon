## changelog-en

### Backup retention: a "keep only the latest backup" option in instance settings (BACKUP-KEEP-LAST, UI part)

- The general instance settings page shows a "Keep only the latest backup"
  option next to the daily/weekly/monthly retention presets. It is active when
  `backupRetention.keepLastOnly` is `true` and is saved through the existing
  `PATCH /api/instance/settings/general` with
  `{"backupRetention": {..., "keepLastOnly": true}}`.
- Picking any daily/weekly/monthly preset turns the mode back off
  (`keepLastOnly: false`) so the two ways of configuring retention never fight
  each other; while the mode is on, a hint under the presets explains that the
  presets are ignored.
- The contract is additive (`keepLastOnly?: boolean` on
  `BackupRetentionPolicy`); the server part ships separately.
- A safety note under the option states the server behaviour: older backups are
  deleted only after the new dump passes verification, so a broken new dump
  leaves the older copies in place (nothing is lost, but disk space is not freed
  until the next successful run).

## changelog-ru

### Хранение резервных копий: вариант «хранить только последнюю копию» в настройках инстанса (BACKUP-KEEP-LAST, часть UI)

- На странице общих настроек инстанса рядом с пресетами хранения по дням,
  неделям и месяцам появился вариант «Хранить только последнюю копию». Он
  активен, когда `backupRetention.keepLastOnly` равен `true`, и сохраняется
  через существующий `PATCH /api/instance/settings/general` с телом
  `{"backupRetention": {..., "keepLastOnly": true}}`.
- Выбор любого пресета выключает режим обратно (`keepLastOnly: false`), чтобы
  два способа настройки хранения не конфликтовали; пока режим включён, под
  пресетами показана подсказка, что пресеты игнорируются.
- Контракт только расширяется (`keepLastOnly?: boolean` в
  `BackupRetentionPolicy`); серверная часть поставляется отдельно.
- Под вариантом показана подсказка о поведении сервера: прежние копии
  удаляются только после успешной проверки новой, поэтому при битой новой
  копии старые остаются на месте — данные не потеряются, но место на диске
  освободится только при следующем успешном прогоне.
