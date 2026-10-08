## changelog-en

### Run queue wait reason and priority settings in the UI (RUN-PRIORITY B)

- `ui/src/components/myrmidon/runQueueApi.ts` — client for the server core:
  `GET/PATCH /api/myrmidon/run-priority` (switch, role weights, default role
  weight, current-release line and bonus, aging step/weight/cap, starvation
  limit) and the queued run's own `waitReason` read from
  `GET /api/heartbeat-runs/:runId`. A 404/405 answers `null`: an older server
  shows no data instead of an invented number.
- `ui/src/components/myrmidon/RunQueueWaitLine.tsx` — the line under a queued
  run's chat card: "waiting: the host CPU ceiling is closed". The core
  publishes no queue rank, so the line shows the reason only (and a rank too,
  if the comment metadata ever carries one). Renders nothing for a run that has
  left the queue.
- `ui/src/components/IssueChatThread.tsx` — mounts the wait line under the
  queued run card (the same card that already shows the "Queued" badge).
- `ui/src/components/myrmidon/RunQueuePrioritySettingsPanel.tsx` and
  `ui/src/pages/InstanceGeneralSettings.tsx` — the queue-priority section of
  Instance → General, on the runtime-limits pattern: five role weights
  (review, release, lead, engineer, docs; an empty one falls back to the
  default role weight; roles set through the API are kept on save), the
  priority switch, the current-release line and bonus, the aging step, step
  weight and cap, and the starvation limit. Values are checked against the
  server bounds before the save; the section says whether the stored row or
  the environment decides. Saving applies on the next admission pass without a
  restart.
- `ui/src/i18n/myrmidon-locales/{en,ru}.json` — the `runQueue` catalog (en+ru,
  parity-checked).

## changelog-ru

### Причина ожидания прогона в очереди и настройки приоритета в UI (RUN-PRIORITY ч.B)

- `ui/src/components/myrmidon/runQueueApi.ts` — клиент серверного ядра:
  `GET/PATCH /api/myrmidon/run-priority` (переключатель, веса ролей, вес
  остальных ролей, строка текущего релиза и надбавка, шаг, вес шага и предел
  старения, предел ожидания) и `waitReason` самого прогона из
  `GET /api/heartbeat-runs/:runId`. Ответ 404/405 даёт `null`: старый сервер
  показывает отсутствие данных, а не выдуманное число.
- `ui/src/components/myrmidon/RunQueueWaitLine.tsx` — строка под карточкой
  прогона в очереди: «ожидание: закрыт предел CPU хоста». Ядро не публикует
  место в очереди, поэтому строка показывает причину (и место, если оно когда-то
  придёт в метаданных комментария). Для прогона, вышедшего из очереди, ничего
  не показывается.
- `ui/src/components/IssueChatThread.tsx` — подключение строки ожидания под
  карточкой прогона в очереди (там же, где значок «В очереди»).
- `ui/src/components/myrmidon/RunQueuePrioritySettingsPanel.tsx` и
  `ui/src/pages/InstanceGeneralSettings.tsx` — раздел «Приоритет очереди» в
  Инстанс → Общие по образцу лимитов прогонов: пять весов ролей (review,
  release, lead, engineer, docs; пустой вес заменяется весом остальных ролей;
  роли, заданные через API, при сохранении не теряются), переключатель
  приоритета, строка текущего релиза и надбавка, шаг, вес шага и предел
  старения, предел ожидания. Значения проверяются по границам сервера до
  сохранения; раздел показывает, что решает — сохранённая строка или окружение.
  Сохранение применяется на следующем проходе допуска без перезапуска.
