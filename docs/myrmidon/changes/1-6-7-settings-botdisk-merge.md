## changelog-en

### Saving the bot disk settings no longer erases keys the screen does not show (SETTINGS-BOTDISK-MERGE)

- Found by QA on 1.6.7-rc.9: after a Save of Settings -> General -> "Bot disk lifecycle" the stored `general.botDisk.gitMigrationEnabled: true` was gone, so `MYRMIDON_GIT_MIGRATION_ENABLED` was no longer set when a bot container was recreated.
- Cause: `PATCH /api/myrmidon/bot-disk` merges the patch over `resolveBotDiskSettings(...).settings` and stores the result as the whole `botDisk` object (instance settings replace nested objects). That effective view left out the five BOT-DISK-H5c / OPE-9673 mechanics keys (`botdIntervalSec`, `legacyPressureIdleDays`, `hermesPruneEnabled`, `hermesPruneDays`, `gitMigrationEnabled`), so any PATCH of another key (also every Save of this panel) dropped them from the row.
- Fix: the effective settings now carry every stored mechanics key, so the merge keeps them; an explicit `null` still returns a key to its default. `GET /api/myrmidon/bot-disk` shows these keys when they are stored. No contract change, no UI change.

## changelog-ru

### Сохранение настроек диска ботов больше не стирает ключи, которых нет на экране (SETTINGS-BOTDISK-MERGE)

- Нашла приёмка на 1.6.7-rc.9: после «Сохранить» в Настройки -> Общие -> «Жизненный цикл диска ботов» пропал сохранённый `general.botDisk.gitMigrationEnabled: true`, и при пересоздании контейнера бота переменная `MYRMIDON_GIT_MIGRATION_ENABLED` больше не выставлялась.
- Причина: `PATCH /api/myrmidon/bot-disk` сливает патч поверх `resolveBotDiskSettings(...).settings` и сохраняет результат как весь объект `botDisk` (общие настройки инстанса заменяют вложенные объекты целиком). В этом действующем представлении не было пяти ключей механики BOT-DISK-H5c / OPE-9673 (`botdIntervalSec`, `legacyPressureIdleDays`, `hermesPruneEnabled`, `hermesPruneDays`, `gitMigrationEnabled`), поэтому любой PATCH другого ключа (в том числе каждое сохранение этой панели) убирал их из строки.
- Исправление: действующие настройки теперь содержат все сохранённые ключи механики, слияние их сохраняет; явный `null` по-прежнему возвращает ключ к умолчанию. `GET /api/myrmidon/bot-disk` показывает эти ключи, если они сохранены. Контракт и интерфейс не менялись.
