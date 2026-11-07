## changelog-en

### Bot runtime: state.db is compacted by its share of free pages, and its temporary copy goes to the bot's volume (1.6.6 BOT-DISK)

The `state.db` of a bot never shrank. On the fleet 15.6 GB of 39.9 GB of the 65 databases were free pages (56% of the
largest, 3.4 GB), and none of them had ever been vacuumed. Hermes vacuums only in a pass whose own prune deleted a
session, and the bot runtime deletes old sessions through the API when a container starts, before hermes' first
maintenance tick, so the tick's prune never found anything. Patch `30` of the bot runtime
(`docker/bot-runtime/patches/`) and the entrypoint change this:

- **The VACUUM runs on the share of free pages.** When more than 25% of the pages are free
  (`AUTO_VACUUM_MIN_FREELIST_RATIO`) and `sessions.min_vacuum_interval_days` (default 30) have passed since the last
  one, the maintenance pass vacuums whether or not it pruned anything. `sessions.vacuum_after_prune: false` still
  turns it off.
- **It waits for room and for a quiet moment.** No VACUUM starts while another process holds the store, while a
  session turn lease is held in the store, while the gateway is running a turn (messaging platforms and API-server
  runs), when the volume has less than twice the live data free, or when SQLite's temp directory is RAM. It then
  tries again on the next housekeeping tick (hourly), not after another 24 hours. The reason is logged and returned
  as `vacuum_skipped`; a finished VACUUM logs the size before and after.
- **The temporary copy is not charged to the container's memory.** SQLite writes the copy of the live data (about
  1.5 GB for the largest database) to `/tmp`, which in the bot container is tmpfs. The entrypoint now exports
  `SQLITE_TMPDIR=$HERMES_HOME/.sqlite-tmp`, a directory on the bot's volume.
- The first passes after the rollout vacuum the databases that have waited so far: the 19 databases above 25% free
  are the ones that shrink. Each gateway decides for itself at its own hourly tick, roughly an hour after it started,
  so the starts follow the sequential restarts of the rollout; there is no fleet-wide limit on simultaneous VACUUMs.
  A bot that is never idle waits for a quiet moment.
- To verify, find `state.db VACUUM: ... MB -> ... MB` in a bot's gateway log, and `state_meta.last_vacuum` in its
  `state.db`.

## changelog-ru

### Рантайм ботов: state.db сжимается по доле свободных страниц, временная копия идёт на том бота (1.6.6 BOT-DISK)

`state.db` бота не уменьшался никогда. По флоту 15,6 ГБ из 39,9 ГБ в 65 базах — свободные страницы (56% у самой
крупной, 3,4 ГБ), и ни одна база ни разу не проходила VACUUM. Hermes делает VACUUM только в проходе, где его
собственная очистка удалила сессию, а рантайм бота удаляет старые сессии через API при старте контейнера, до первого
тика обслуживания hermes, поэтому очистка тика ничего не находила. Патч `30` рантайма ботов
(`docker/bot-runtime/patches/`) и entrypoint это меняют:

- **VACUUM идёт по доле свободных страниц.** Когда свободно больше 25% страниц (`AUTO_VACUUM_MIN_FREELIST_RATIO`) и
  с прошлого VACUUM прошло `sessions.min_vacuum_interval_days` (по умолчанию 30) дней, проход обслуживания делает
  VACUUM независимо от того, удалил ли он что-нибудь. `sessions.vacuum_after_prune: false` по-прежнему его выключает.
- **Он ждёт места и тихого момента.** VACUUM не начинается, пока базу держит другой процесс, пока в базе есть
  действующая аренда хода сессии, пока шлюз ведёт ход (платформы сообщений и прогоны API-сервера), если на томе
  свободно меньше двух объёмов живых данных или если временный каталог SQLite — оперативная память. Затем проход
  повторяется на следующем тике обслуживания (раз в час), а не через ещё 24 часа. Причина пишется в лог и
  возвращается как `vacuum_skipped`; завершённый VACUUM пишет в лог размер до и после.
- **Временная копия не засчитывается в память контейнера.** SQLite пишет копию живых данных (около 1,5 ГБ у самой
  крупной базы) в `/tmp`, а это в контейнере бота tmpfs. Теперь entrypoint экспортирует
  `SQLITE_TMPDIR=$HERMES_HOME/.sqlite-tmp` — каталог на томе бота.
- Первые проходы после выката сожмут накопившиеся базы: уменьшатся 19 баз, у которых свободно больше 25%. Каждый
  шлюз решает сам на своём часовом тике, примерно через час после старта, поэтому старты повторяют последовательные
  перезапуски выката; общего предела на одновременные VACUUM нет. Бот, который никогда не простаивает, ждёт тихого
  момента.
- Проверка: в логе шлюза бота строка `state.db VACUUM: ... MB -> ... MB`, в его `state.db` ключ
  `state_meta.last_vacuum`.
