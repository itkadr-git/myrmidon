## changelog-en

### The board no longer leaks SSH sync-back copies into its /tmp (OPE-12727)

- Pulling a run's workspace back from an SSH runner stages it in `/tmp/paperclip-ssh-sync-back-*` on the board, and copies stayed there: on 12.11 they held 26 GB (0.7–4.1 GB each) and the root disk blocked a deploy. A restore now stops `ssh` when the local `tar` fails (before, the board process could crash on an unhandled `EPIPE` or wait on a full pipe, and the cleanup never ran), drops a dead connection after about three minutes of silence, makes read-only directories (a Go module cache) removable before deleting the copy, and logs a copy it cannot remove. Each restore also removes sync-back copies older than four hours, which covers a board restart in the middle of a restore.

## changelog-ru

### Доска больше не копит копии возврата SSH в своём /tmp (OPE-12727)

- Возврат рабочей копии прогона с SSH-исполнителя складывается на доске в `/tmp/paperclip-ssh-sync-back-*`, и копии оставались там: 12.11 их было 26 ГБ (каждая 0,7–4,1 ГБ), корневой диск остановил выкат. Теперь возврат останавливает `ssh`, когда падает локальный `tar` (раньше доска могла вылететь с необработанной ошибкой `EPIPE` или зависнуть на полной трубе, и очистка не выполнялась), обрывает мёртвое соединение примерно через три минуты тишины, снимает запрет на запись с каталогов только для чтения (кэш модулей Go) перед удалением копии и пишет в журнал копию, которую не удалось убрать. В начале каждого возврата также удаляются копии старше четырёх часов, это закрывает перезапуск доски посреди возврата.
