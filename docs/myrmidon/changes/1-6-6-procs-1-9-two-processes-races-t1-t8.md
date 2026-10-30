## changelog-en

### Integration stand "two processes, one database" and race tests T1–T8 (PROCS-1.9, OPE-5415)

- Added `server/src/__tests__/procs/procs-races-t1-t8.test.ts` implementing the end-to-end integration test stand against a single shared test database (embedded Postgres) verifying all 8 race conditions T1–T8 from design OPE-5394 §8 / §10:
  - T1: Two executors dispatching one agent's queue through the real claim path (`dispatchRunStart`) do not duplicate starts; each run gets exactly one `running` transition.
  - T2: Dual leader / lease expiry: a standby does not steal a live lease and takes over after release; two concurrent reattach sweeps adopt an expired run exactly once.
  - T3: Bot container apply on an api process answers 409 `bot_containers_disabled`, journals no apply job and leaves the card untouched (the `caller_not_board_main` verdict is the docker gate's and is covered by its Go tests).
  - T4: Gateway run reattach protects active controller leases and ensures expired leases are adopted by exactly one surviving process.
  - T5: A real `PATCH /api/myrmidon/processes` through one api process is read through the other, and concurrent PATCHes of different keys through both processes lose no edit.
  - T6: Two real `ProcessBus` instances with their own LISTEN connections on the shared database: a `live_event` published on one process reaches the other, the origin filter keeps it from coming back, and another channel is not delivered. (The bus itself is covered here; this build does not yet publish live events onto it.)
  - T7: The real process supervisor moves single -> split (two real api children) -> single under a steady request load against the shared port, with zero 5xx; the budget is at most one connection error per transition (same as the drain/failover suite). It runs as a second suite in the same file with its own database.
  - T8: A real `SIGKILL` of an api process holding a run lease: the survivor keeps serving, the dead process's registry row stays until the reaper window, the live lease is not stolen, and after it expires the reattach sweep re-claims the run exactly once. The reaper's 2 minute window is not waited for.

- Fixed a lost update found by T5: `PATCH /api/myrmidon/processes` read, merged and wrote the processes settings outside any cross-process lock, so two processes saving different keys at once could drop one of them. The whole read-merge-write now runs under a database advisory lock.

## changelog-ru

### Интеграционный стенд «два процесса, одна БД» и тесты гонок Т1–Т8 (PROCS-1.9, OPE-5415)

- Добавлен тестовый набор `server/src/__tests__/procs/procs-races-t1-t8.test.ts`, реализующий сквозной интеграционный стенд против единой общей базы данных (embedded Postgres) и проверяющий 8 сценариев гонок Т1–Т8 из документа design OPE-5394 §8 / §10:
  - Т1: Два исполнителя, диспетчеризующие очередь одного агента через настоящий путь клейма (`dispatchRunStart`), не удваивают старты; каждый прогон получает ровно один переход в `running`.
  - Т2: Двойной лидер и истечение аренды: резервный процесс не перехватывает живую аренду и принимает её после release; два одновременных свипа reattach подхватывают просроченный прогон ровно один раз.
  - Т3: Применение контейнера бота на api-процессе отвечает 409 `bot_containers_disabled`, не пишет apply-задачу и не меняет карточку (вердикт `caller_not_board_main` принадлежит docker-гейту и покрыт его Go-тестами).
  - Т4: Протокол reattach защищает живые аренды контроллера, а прогоны с истёкшей арендой подхватываются ровно одним выжившим процессом.
  - Т5: Настоящий `PATCH /api/myrmidon/processes` через один api-процесс виден через другой, а параллельные PATCH разных ключей через оба процесса не теряют правок.
  - Т6: Две настоящие шины `ProcessBus` со своими LISTEN-соединениями на общей базе: `live_event`, опубликованный в одном процессе, доходит до другого, origin-фильтр не возвращает его обратно, сообщение другого канала не доставляется. (Покрыта сама шина; в этой сборке live-события в неё ещё не публикуются.)
  - Т7: Настоящий супервизор процессов переводит single -> split (два настоящих api-потомка) -> single под ровной нагрузкой на общий порт: 0 ответов 5xx, допуск — не более одной ошибки соединения на переход (как в наборе drain/failover). Идёт вторым набором в том же файле на своей базе.
  - Т8: Настоящий `SIGKILL` api-процесса, держащего аренду прогона: выживший продолжает отвечать, строка мёртвого процесса остаётся до окна reaper, живая аренда не отбирается, после её истечения свип reattach подхватывает прогон ровно один раз. Окно reaper в 2 минуты не ждётся.
- Исправлена потерянная правка, найденная Т5: `PATCH /api/myrmidon/processes` читал, сливал и писал настройки процессов вне межпроцессной блокировки, поэтому два процесса, одновременно сохраняющие разные ключи, могли затереть один из них. Теперь весь цикл чтение-слияние-запись идёт под advisory-блокировкой базы.
