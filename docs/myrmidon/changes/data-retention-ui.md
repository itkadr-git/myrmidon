## changelog-en

### Data retention: the run and log windows in instance settings (1.6.5-DB-RETENTION, UI part)

- The general instance settings page shows a "Data retention" panel that edits
  the three whole-day windows of the grown tables: "Run history"
  (`heartbeatRunsDays`), "Activity log" (`activityLogDays`) and "Access audit
  logs" (`accessAuditDays`). `0` keeps the rows forever. The values are saved
  through `PATCH /api/myrmidon/data-retention` and the cleanup sweep re-reads
  them on every run, so a saved value applies without a restart.
- An input accepts only a whole number of days (`0` or more); anything else —
  a negative or fractional draft — shows an inline error and no request is
  sent, the same draft pattern the host disk panel uses.
- The panel reads `GET /api/myrmidon/data-retention` and shows the state of the
  last cleanup: the time of the last sweep and of the last backup check, how
  many rows were deleted and how many bytes were freed per table group, and the
  total freed.
- While the sweep is waiting for a fresh backup (`waitingForBackup: true`) the
  panel shows a visible note that cleanup starts once a backup younger than
  24 hours exists — nothing is deleted until then.
- Each window also shows whether its value comes from the stored settings or
  from the default. The server side of the feature ships separately; until it
  lands, the panel reads the contract above.

## changelog-ru

### Хранение данных: сроки для прогонов и журналов в настройках инстанса (1.6.5-DB-RETENTION, часть UI)

- На странице общих настроек инстанса появилась панель «Хранение данных» с
  тремя сроками в целых днях для выросших таблиц: «История прогонов»
  (`heartbeatRunsDays`), «Журнал активности» (`activityLogDays`) и «Журнал
  доступа» (`accessAuditDays`). Значение `0` хранит строки бессрочно. Значения
  сохраняются через `PATCH /api/myrmidon/data-retention`, а прогон очистки
  перечитывает их каждый раз, поэтому сохранённое значение применяется без
  перезапуска.
- Поле принимает только целое число дней (`0` и больше); всё остальное —
  отрицательное или дробное значение — показывает ошибку рядом с полем, запрос
  не отправляется (тот же шаблон черновика, что и в панели диска хоста).
- Панель читает `GET /api/myrmidon/data-retention` и показывает состояние
  последней очистки: время последнего прогона и последней проверки резервной
  копии, сколько строк удалено и сколько байт освобождено по группам таблиц и
  всего.
- Пока очистка ждёт свежую резервную копию (`waitingForBackup: true`), панель
  показывает заметную подсказку, что удаление начнётся, когда появится копия
  моложе 24 часов — до этого не удаляется ничего.
- Для каждого срока также видно, откуда взято значение: из сохранённых
  настроек или по умолчанию. Серверная часть поставляется отдельно; до её
  слияния панель работает по описанному контракту.