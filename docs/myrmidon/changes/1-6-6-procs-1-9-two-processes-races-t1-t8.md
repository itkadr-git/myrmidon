## changelog-en

### Integration stand "two processes, one database" and race tests T1–T8 (PROCS-1.9, OPE-5415)

- Added `server/src/__tests__/procs/procs-races-t1-t8.test.ts` implementing the end-to-end integration test stand against a single shared test database (embedded Postgres) verifying all 8 race conditions T1–T8 from design OPE-5394 §8 / §10:
  - T1: Two executors claiming queued runs concurrently do not duplicate starts; each run transitions to running with exactly one unique `controllerBootId`.
  - T2: Sweeps under dual leader / lease expiry are serialized; standby does not steal a live lease and sweeps remain idempotent.
  - T3: Bot container reconciliation gate rejects unpinned processes (`caller_not_board_main` / 403), preserving container state.
  - T4: Gateway run reattach protects active controller leases and ensures expired leases are adopted by exactly one surviving process.
  - T5: Instance settings propagation across processes and concurrent row-level locking (`SELECT ... FOR UPDATE`) preserves all updates.
  - T6: Live events cross-process flow delivers events to peer subscribers and origin filtering prevents reflection loops.
  - T7: Single <-> split mode switching under concurrent requests maintains zero connection errors and zero 5xx responses.
  - T8: Abrupt worker exit (`kill -9`) recovery verifies lease expiration and reattach/reaper cleanup.

## changelog-ru

### Интеграционный стенд «два процесса, одна БД» и тесты гонок Т1–Т8 (PROCS-1.9, OPE-5415)

- Добавлен тестовый набор `server/src/__tests__/procs/procs-races-t1-t8.test.ts`, реализующий сквозной интеграционный стенд против единой общей базы данных (embedded Postgres) и проверяющий 8 сценариев гонок Т1–Т8 из документа design OPE-5394 §8 / §10:
  - Т1: Два конкурирующих исполнителя не удваивают старты; каждый queued-прогон переходит в running ровно с одним `controllerBootId`.
  - Т2: Свипы при двойном лидере и истечении аренды сериализованы; резервный процесс не перехватывает живую аренду, операции идемпотентны.
  - Т3: Гейт реконсиляции контейнеров ботов отклоняет запросы непривязанных процессов (`caller_not_board_main` / 403), защищая состояние контейнера.
  - Т4: Протокол reattach защищает живые аренды контроллера, а прогоны с истёкшей арендой подхватываются ровно одним выжившим процессом.
  - Т5: Распространение настроек между процессами и параллельные правки под блокировкой `FOR UPDATE` сохраняют все изменения без потерь.
  - Т6: Поток live-событий между процессами доставляет события подписчикам на соседних процессах, а origin bootId предотвращает эхо-петли.
  - Т7: Переключение режимов single <-> split под нагрузкой проходит с 0 ошибок соединения и 0 5xx.
  - Т8: Восстановление при резком падении воркера (`kill -9`) гарантирует истечение аренды и очистку/подхват через reattach и reaper.
