## changelog-en

### Integration stand "two processes, one database" and race tests T1–T8 (PROCS-1.9, OPE-5415)

- Added `server/src/__tests__/procs/procs-races-t1-t8.test.ts` implementing the end-to-end integration test stand against a single shared test database (embedded Postgres) verifying all 8 race conditions T1–T8 from design OPE-5394 §8 / §10:
  - T1: Two executors dispatching one agent's queue through the real claim path (`dispatchRunStart`) do not duplicate starts; each run gets exactly one `running` transition.
  - T2: Dual leader / lease expiry: a standby does not steal a live lease and takes over after release; two concurrent reattach sweeps adopt an expired run exactly once.
  - T3: Bot container apply on an api process answers 409 `bot_containers_disabled`, journals no apply job and leaves the card untouched (the `caller_not_board_main` verdict is the docker gate's and is covered by its Go tests).
  - T4: Gateway run reattach protects active controller leases and ensures expired leases are adopted by exactly one surviving process.
  - T5: Instance settings propagation across processes and concurrent row-level locking (`SELECT ... FOR UPDATE`) preserves all updates.
  - T6: Live events cross-process flow delivers events to peer subscribers and origin filtering prevents reflection loops.
  - T7: Single <-> split mode switching under concurrent requests maintains zero connection errors and zero 5xx responses.
  - T8: Abrupt worker exit (`kill -9`) recovery verifies lease expiration and reattach/reaper cleanup.

## changelog-ru

### Интеграционный стенд «два процесса, одна БД» и тесты гонок Т1–Т8 (PROCS-1.9, OPE-5415)

- Добавлен тестовый набор `server/src/__tests__/procs/procs-races-t1-t8.test.ts`, реализующий сквозной интеграционный стенд против единой общей базы данных (embedded Postgres) и проверяющий 8 сценариев гонок Т1–Т8 из документа design OPE-5394 §8 / §10:
  - Т1: Два исполнителя, диспетчеризующие очередь одного агента через настоящий путь клейма (`dispatchRunStart`), не удваивают старты; каждый прогон получает ровно один переход в `running`.
  - Т2: Двойной лидер и истечение аренды: резервный процесс не перехватывает живую аренду и принимает её после release; два одновременных свипа reattach подхватывают просроченный прогон ровно один раз.
  - Т3: Применение контейнера бота на api-процессе отвечает 409 `bot_containers_disabled`, не пишет apply-задачу и не меняет карточку (вердикт `caller_not_board_main` принадлежит docker-гейту и покрыт его Go-тестами).
  - Т4: Протокол reattach защищает живые аренды контроллера, а прогоны с истёкшей арендой подхватываются ровно одним выжившим процессом.
  - Т5: Распространение настроек между процессами и параллельные правки под блокировкой `FOR UPDATE` сохраняют все изменения без потерь.
  - Т6: Поток live-событий между процессами доставляет события подписчикам на соседних процессах, а origin bootId предотвращает эхо-петли.
  - Т7: Переключение режимов single <-> split под нагрузкой проходит с 0 ошибок соединения и 0 5xx.
  - Т8: Восстановление при резком падении воркера (`kill -9`) гарантирует истечение аренды и очистку/подхват через reattach и reaper.
