## changelog-en

### `myrmidon:migrate` accepts Paperclip releases v2026.1001.0, v2026.1005.0 and v2026.1012.0 (MIGRATE-D)

- The source can now be any of the Paperclip releases `v2026.916.1`, `v2026.1001.0`, `v2026.1005.0` or
  `v2026.1012.0`. The release is recognised by the exact hashes of the applied migrations and is
  named in the dry-run report (`source.vendorRelease`). Truncated, extended and foreign
  histories are still refused before any write, now with the list of supported releases.
- Data of Paperclip features that Myrmidon does not have (tables and columns added after
  `v2026.916.1`, such as browser-use runs or MCP OAuth clients) is no longer an error. The dry run
  lists it as `vendorOnlyData`: table or column, rows that hold data, release. When any of it
  holds data a real run stops before the first write unless `--accept-vendor-only-data` is given;
  that data is not transferred. Empty ones are left out and reported. Other schema differences
  stay errors. A value that does not fit a narrower target column (`assets.byte_size`, `bigint` to
  `integer`) is refused before rows are copied.
- Adding the next Paperclip release is one command (`scripts/myrmidon/vendor-release-add.mjs <tag>`),
  and a daily workflow fails when a new Paperclip release is published that is not in the list.

## changelog-ru

### `myrmidon:migrate` принимает релизы Paperclip v2026.1001.0, v2026.1005.0 и v2026.1012.0 (MIGRATE-D)

- Источником может быть любой из релизов Paperclip `v2026.916.1`, `v2026.1001.0`, `v2026.1005.0`
  или `v2026.1012.0`. Релиз определяется по точным хэшам применённых миграций и называется в отчёте
  пробного прогона (`source.vendorRelease`). Обрезанная, удлинённая и чужая история по-прежнему
  отклоняются до любой записи, теперь со списком поддерживаемых релизов.
- Данные возможностей Paperclip, которых нет в Myrmidon (таблицы и столбцы, добавленные после
  `v2026.916.1`, например запуски browser-use или клиенты MCP OAuth), больше не ошибка. Пробный
  прогон перечисляет их в `vendorOnlyData`: таблица или столбец, число строк с данными, релиз. Если
  в них есть данные, настоящий запуск останавливается до первой записи, пока не указан
  `--accept-vendor-only-data`; эти данные не переносятся. Пустые исключаются и попадают в отчёт.
  Остальные расхождения схемы остаются ошибками. Значение, не помещающееся в более узкий столбец
  цели (`assets.byte_size`, `bigint` в `integer`), отклоняется до копирования строк.
- Добавить следующий релиз Paperclip — одна команда (`scripts/myrmidon/vendor-release-add.mjs <tag>`);
  ежедневный workflow падает, если вышел новый релиз Paperclip, которого нет в списке.
