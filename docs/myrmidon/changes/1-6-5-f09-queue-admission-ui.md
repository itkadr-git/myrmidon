---
divergence-section: 1.6.2 — RUN-ADMISSION: допуск прогонов по свободной памяти хоста и плавный старт
---

## changelog-en

### F-09 B-UI: admission denial counter on the "Runs & queue" screen (1.6.5)

- The "Runs & queue" screen shows, next to the queue and memory snapshots,
  how many times the admission sweep refused to start a queued run since the
  server started: the total, the breakdown by gate (global cap, start ramp,
  memory of the server container, free memory of the host, host CPU load) and
  the most recent refusal with its reason and time.
- The counter comes from the `admissionDenials` field of the runtime-limits
  response (the field and its type are shipped by the legacy-screen change;
  this change wires the ui2 screen to it). Gates with zero refusals are not
  listed, and a reason this build does not know is shown exactly as the
  server sends it.
- The field is optional: a server that does not send it (or sends `null`)
  leaves the whole block hidden and the screen keeps working. Both UI
  languages are covered.

## changelog-ru

### F-09 B-UI: счётчик admission-отказов на экране «Прогоны и очередь» (1.6.5)

- На экране «Прогоны и очередь» рядом со снимками очереди и памяти видно,
  сколько раз с запуска сервера проход допуска не пустил queued-прогон:
  всего, разбивка по гейтам (общий потолок, плавный старт, память контейнера
  сервера, свободная память хоста, загрузка CPU хоста) и последний отказ с
  причиной и временем.
- Счётчик берётся из поля `admissionDenials` ответа о лимитах прогонов
  (само поле и его тип уже влиты правкой легаси-экрана; эта правка
  подключает к ним экран ui2). Гейты без отказов не перечисляются, а
  незнакомая этой сборке причина показывается так, как её прислал сервер.
- Поле необязательное: сервер, который его не отдаёт (или отдаёт `null`),
  оставляет весь блок скрытым, экран продолжает работать. Обе локали
  интерфейса покрыты.

## divergence

| 1.6.5-F09-B-UI | В панели «Прогоны и очередь» (ui2) рядом со снимками очереди и памяти показывается счётчик глобальных admission-отказов из поля `admissionDenials` ответа `GET /api/myrmidon/runtime-limits` (поле и тип уже влиты правкой легаси-экрана): всего отказов с запуска сервера, разбивка по причинам (`global_cap` / `start_ramp` / `memory` / `host_memory` / `host_cpu`, гейты без отказов не показываются) и последний отказ с причиной и временем (`lastReason` / `lastAt`); незнакомая причина выводится как есть; поле необязательное — сервер без него (или с `null`) оставляет блок скрытым, экран не падает; строки в обеих локалях ui2 | `ui/src/ui2/screens/settings/runs-queue/Ui2RunsSettings.tsx` (блок счётчика рядом с очередью), `ui/src/ui2/i18n/locales.ts` (`ui2.settings.runs.denials.*`, EN + RU) | Оператор видит, сколько раз допуск не пустил очередь и какой гейт её держал, не заходя в журнал сервера | `ui/src/ui2/screens/settings/runs-queue/Ui2RunsSettings.myrmidon.test.tsx` (счётчик с разбивкой и последним отказом, нулевые гейты скрыты, блок скрыт без поля и при `null`, незнакомая причина как есть, обе локали) | Никогда, наше поведение. Снятие: удалить блок счётчика из экрана и строки `denials.*` из локалей | (этот PR) |