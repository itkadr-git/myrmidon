## changelog-en

### Migration guide: plain-language introduction and where source-only data goes (MIGRATE-D4)

- The guide for `myrmidon:migrate` now opens with what the command does, that the source is never changed and the command writes only to the empty target it creates, and when it stops. It also explains that data of Paperclip features that Myrmidon lacks is not copied into the database but listed in the report under `vendorOnlyData`. Russian version: `migration-from-paperclip.ru.md`.

## changelog-ru

### Руководство по миграции: простое вступление и куда попадают данные, которых нет в Myrmidon (MIGRATE-D4)

- Руководство по `myrmidon:migrate` теперь начинается с того, что делает команда, что источник не меняется, а запись идёт только в пустую цель, которую команда создаёт сама, и когда она останавливается. Также объяснено, что данные возможностей Paperclip, которых нет в Myrmidon, не копируются в базу, а перечисляются в отчёте в разделе `vendorOnlyData`. Английская версия: `migration-from-paperclip.md`.
