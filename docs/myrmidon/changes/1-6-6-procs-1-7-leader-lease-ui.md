## changelog-en

### The leader lease of the board is visible in the panel (PROCS-1.7 part B)

Instance settings now carries a leader-lease block: one row per `board_leases`
entry — the lease name (scheduler, backup, bot operations), the holder (`boot_id`
plus the `hostname`/`pid`/role of its `board_processes` row while that row still
exists), `epoch`, `acquired_at`, `expires_at`, and whether the process behind the
panel is the leader of that lease.

- The block reads `GET /api/myrmidon/processes/leases` and refreshes every 10
  seconds; a `leader_changed` live event cuts the wait short, so a handover is
  visible without restarting the board. The route is part A of the same task
  (OPE-5413) and is mocked with `docs/myrmidon/board-leases-contract/*.json`
  until that half merges — the two halves do not touch the same files.
- Every state is spelled out instead of showing an empty cell: a lease whose
  process row is gone, an expired lease with the epoch and lifetime that came
  with it, and an empty lease table. Timestamps are printed in UTC so the panel
  lines up with the server log.
- If the route is missing from the build (or the API is down), the block reports
  "No data" and the rest of the panel keeps working; the page does not fail.
- A single-process board behaves as before: one lease row, held by the running
  process. The block is self-contained, so the «Процессы» panel (PROCS-0.1) picks
  it up with one import and one line.

## changelog-ru

### Аренда лидера доски видна в панели (PROCS-1.7, часть B)

В настройках инстанса появился блок аренд лидера: по строке на каждую запись
`board_leases` — имя аренды (планировщик, резервное копирование, операции
ботов), держатель (`boot_id` и `hostname`/`pid`/роль его строки в
`board_processes`, пока эта строка жива), `epoch`, `acquired_at`, `expires_at`
и признак того, что лидером этой аренды является процесс, отдавший панель.

- Блок читает `GET /api/myrmidon/processes/leases` и обновляется раз в 10
  секунд; живое событие `leader_changed` сокращает ожидание, поэтому передача
  аренды видна без перезапуска доски. Сам маршрут — часть A той же задачи
  (OPE-5413) и до её слияния подменён моками
  `docs/myrmidon/board-leases-contract/*.json`; половины не пересекаются по
  файлам.
- Каждое состояние названо словами вместо пустой ячейки: аренда, чья строка
  процесса исчезла, истёкшая аренда с эпохой и сроком и пустая таблица аренд.
  Отметки времени печатаются в UTC, чтобы панель сходилась с серверным логом.
- Если маршрута в сборке нет (или API недоступен), блок показывает «нет
  данных», а остальная панель продолжает работать: страница не падает.
- Доска из одного процесса работает как раньше: одна строка аренды, её держит
  текущий процесс. Блок самодостаточен, поэтому панель «Процессы» (PROCS-0.1)
  подхватывает его одним импортом и одной строкой.