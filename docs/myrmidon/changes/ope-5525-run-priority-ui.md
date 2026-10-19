## changelog-en

### Run queue position, wait reason and priority settings in the UI (OPE-5525, RUN-PRIORITY B)

- `ui/src/components/myrmidon/runQueueApi.ts` — client for the part A
  (OPE-5526) endpoints: `GET /api/myrmidon/run-queue/position?runId=…` (rank
  in the waiting queue + wait reason), `GET/PATCH
  /api/myrmidon/run-queue/priority` (role weights, current-release line and
  bonus, aging step and cap). Every read answers `null` on 404/405 — before
  part A deploys the UI shows no position instead of inventing one.
- `ui/src/components/myrmidon/RunQueueWaitLine.tsx` — the line under a queued
  run's chat card: "Queue position 3 of 12, waiting: the host CPU ceiling is
  closed". Metadata the comment already carries (part A publishes it) wins
  per field; the position endpoint fills the gaps and is re-asked every 30 s
  while the rank is unknown. Renders nothing when neither source answers.
- `ui/src/components/IssueChatThread.tsx` — mounts the wait line under the
  queued run card (the same card that already shows the "Queued" badge).
- `ui/src/components/myrmidon/RunQueuePrioritySettingsPanel.tsx` and
  `ui/src/pages/InstanceGeneralSettings.tsx` — the queue-priority section of
  Instance → General, on the runtime-limits pattern: five role weights
  (review, release, lead, engineer, docs), the current-release line, its
  bonus, the aging step and cap; per-field source tags (saved here / server
  environment / default); whole-number validation; saving applies on the next
  admission pass without a server restart. When the endpoint is not served
  yet the panel says so instead of pretending to save.
- `ui/src/i18n/myrmidon-locales/{en,ru}.json` — the `runQueue` catalog (en+ru,
  parity-checked).
- Tests: `runQueueApi.myrmidon.test.ts`,
  `RunQueuePrioritySettingsPanel.myrmidon.test.tsx`,
  `RunQueueWaitLine.myrmidon.test.tsx`.

## changelog-ru

### Позиция в очереди прогонов, причина ожидания и настройки приоритета в UI (OPE-5525, RUN-PRIORITY ч.B)

- `ui/src/components/myrmidon/runQueueApi.ts` — клиент эндпоинтов части A
  (OPE-5526): `GET /api/myrmidon/run-queue/position?runId=…` (место в очереди
  ожидания + причина), `GET/PATCH /api/myrmidon/run-queue/priority` (веса
  ролей, строка текущего релиза и надбавка, шаг и предел aging). Любое чтение
  отвечает `null` на 404/405 — до выката части A UI не показывает позицию,
  которой нет, вместо того чтобы выдумывать её.
- `ui/src/components/myrmidon/RunQueueWaitLine.tsx` — строка под карточкой
  прогона в очереди: «Позиция в очереди: 3 из 12, ожидание: закрыт предел CPU
  хоста». Метаданные комментария (публикует часть A) приоритетны по полям;
  эндпоинт позиции дозаполняет пробелы и опрашивается каждые 30 с, пока место
  неизвестно. Когда не отвечает ни один источник — строка не показывается.
- `ui/src/components/IssueChatThread.tsx` — подключение строки ожидания под
  карточкой прогона в очереди (там же, где значок «В очереди»).
- `ui/src/components/myrmidon/RunQueuePrioritySettingsPanel.tsx` и
  `ui/src/pages/InstanceGeneralSettings.tsx` — раздел «Приоритет очереди» в
  Инстанс → Общие по образцу лимитов прогонов: пять весов ролей (review,
  release, lead, engineer, docs), строка текущего релиза, надбавка к нему,
  шаг и предел aging; метка источника у каждого поля (сохранено здесь / из
  окружения сервера / по умолчанию); проверка целых чисел; сохранение
  применяется на следующем проходе допуска без перезапуска сервера. Пока
  эндпоинт не обслуживается, панель честно сообщает об этом вместо видимости
  сохранения.
- `ui/src/i18n/myrmidon-locales/{en,ru}.json` — каталог `runQueue` (en+ru,
  паритет проверен).
- Тесты: `runQueueApi.myrmidon.test.ts`,
  `RunQueuePrioritySettingsPanel.myrmidon.test.tsx`,
  `RunQueueWaitLine.myrmidon.test.tsx`.
