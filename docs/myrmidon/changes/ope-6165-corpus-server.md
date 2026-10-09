## changelog-en

### Knowledge corpus, server side: REST API, the instance block and the parse sweep (CORPUS-2.0 C)

- The board now serves the knowledge corpus over HTTP: datasets (`GET`/`POST`
  `/api/myrmidon/companies/:companyId/corpus/datasets`, `GET`/`PATCH`/`DELETE`
  `…/datasets/:datasetId`), documents (`GET`/`POST
  `…/datasets/:datasetId/documents`, `GET`/`DELETE …/corpus/documents/:id`) and
  search (`POST …/datasets/:datasetId/search`, a proxy to the `SearchIndex`
  port), plus `GET …/corpus/stats` for the screen counters.
- `corpus` is an additive block in `instance_settings.general`: eleven fields
  (module switch, parse-service base URL and timeout, embedder model /
  dimensions / base URL, document and dataset limits, parse concurrency and
  attempts, search top-K). An environment variable is the default at first
  start; afterwards the stored block is the truth, and every save writes one
  activity row per company naming the changed keys.
- The parse worker is a board sweep: it claims queued jobs, parses through the
  parser port, indexes the chunks and settles the document `ready`; a failure
  requeues the job until `maxParseAttempts`, then marks the document `failed`.
  A disabled module — or a process without wired ports — makes the pass a
  no-op, and the API answers 503 instead of pretending an empty corpus.

## changelog-ru

### Корпус знаний, серверная часть: REST API, блок настроек и проход разбора (CORPUS-2.0 C)

- Доска отдаёт корпус знаний по HTTP: датасеты (`GET`/`POST`
  `/api/myrmidon/companies/:companyId/corpus/datasets`, `GET`/`PATCH`/`DELETE`
  `…/datasets/:datasetId`), документы (`GET`/`POST`
  `…/datasets/:datasetId/documents`, `GET`/`DELETE …/corpus/documents/:id`) и
  поиск (`POST …/datasets/:datasetId/search` — прокси к порту `SearchIndex`),
  плюс `GET …/corpus/stats` для счётчиков экрана.
- `corpus` — аддитивный блок в `instance_settings.general`: одиннадцать полей
  (переключатель модуля, base URL и таймаут сервиса разбора, модель, размерность
  и base URL эмбеддера, лимиты документа и датасета, параллелизм и число попыток
  разбора, top-K поиска). Переменная окружения — умолчание при первом запуске;
  дальше истина в сохранённом блоке, а каждое сохранение пишет по одной записи
  активности на компанию с перечнем изменившихся ключей.
- Воркер разбора — проход доски: забирает задания из очереди, разбирает через
  порт парсера, индексирует чанки и закрывает документ в `ready`; сбой
  возвращает задание в очередь до `maxParseAttempts`, затем документ `failed`.
  Выключенный модуль (или процесс без подключённых портов) делает проход
  no-op, а API отвечает 503 вместо вида «пустой корпус».

## settings-en-new

### 1.6.6 — CORPUS-2.0 C: knowledge corpus server side

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_CORPUS_ENABLED` | CORPUS-2.0 C | `0` (off) | Master switch of the corpus module in this process. Off — every corpus route answers 503 `corpus_disabled` and the parse sweep claims nothing; the board behaves exactly as before the module. The value is the default at the FIRST save only: afterwards the switch lives in the stored block (`instance_settings.general.corpus.enabled`), which the module reads on everything it serves, and the settings page is the place to flip it | Only `1`/`true`/`yes`/`on` enable. Unset, a typo or `0` — off: an opt-in module must not switch itself on. In the stored block `false` is explicit |
| `MYRMIDON_CORPUS_PARSER_BASE_URL` · `MYRMIDON_CORPUS_PARSER_TIMEOUT_MS` | CORPUS-2.0 C | unset · `60000` | How the parse sweep reaches the PDF/scan parsing service (its own HTTP service, see the port contract): the base URL has no default — without it a claim fails with `corpus_parser_unconfigured` and the job is retried, so an enabled corpus with no parser never half-parses documents | Unset base URL — nothing to call, the job is requeued and the log names the reason. Timeout: non-numeric or negative — the default |
| `MYRMIDON_CORPUS_EMBEDDER_MODEL` · `_DIMENSIONS` · `_BASE_URL` | CORPUS-2.0 C | `text-embedding-v4` · `1024` · unset (the company LiteLLM gateway) | The embedder the index is written with: model name, vector dimensions (HNSW was built for 1024 in the pilot) and the gateway base URL when a deployment routes embeddings somewhere else | Model/dimensions: unset or invalid — the defaults above; an exotic dimension must match the index schema, otherwise the write fails loudly |
| `MYRMIDON_CORPUS_MAX_DOCUMENT_BYTES` · `_MAX_DOCUMENTS_PER_DATASET` | CORPUS-2.0 C | `26214400` (25 MB) · `1000` | Upload ceilings: a bigger file is refused with 413 `document_too_large` before any byte reaches the BlobStore, and a dataset at its document ceiling answers 409 `dataset_full`. Both are edit-as-needed per instance, not per dataset | `0` or negative — the default; the ceilings cannot be switched off, only raised |
| `MYRMIDON_CORPUS_PARSE_CONCURRENCY` · `_MAX_PARSE_ATTEMPTS` | CORPUS-2.0 C | `2` · `3` | How many documents one pass takes at a time, and how many times a failing parse is retried before the document is marked `failed` with the parser's reason in `error`. Together with the sweep interval these bound the load an enabled corpus puts on the parse service | Non-positive or non-numeric — the default. A retry ceiling of `1` means "no retries"; there is no way to disable the ceiling itself |
| `MYRMIDON_CORPUS_SEARCH_TOP_K` | CORPUS-2.0 C | `5` | How many chunks a search returns when the request does not name a limit. The index does the hybrid vector+FTS ranking behind the `SearchIndex` port; this value only caps the page | The request body wins; out-of-range values fall back to the default |

## settings-ru-new

### 1.6.6 — CORPUS-2.0 C: серверная часть корпуса знаний

| Переменная | Функция | Умолчание | Что делает | Как выключить / особенности |
|---|---|---|---|---|
| `MYRMIDON_CORPUS_ENABLED` | CORPUS-2.0 C | `0` (выкл) | Главный переключатель модуля корпуса в этом процессе. Выключен — все маршруты корпуса отвечают 503 `corpus_disabled`, а проход разбора ничего не забирает: доска ведёт себя ровно как до модуля. Значение работает как умолчание только при ПЕРВОМ сохранении — дальше переключатель живёт в сохранённом блоке (`instance_settings.general.corpus.enabled`), из него модуль берёт состояние для всего, что отдаёт, а переключают его на странице настроек | Включают только `1`/`true`/`yes`/`on`. Не задана, опечатка, `0` — выкл: модуль-опция не должен включать себя сам. В сохранённом блоке `false` — явное значение |
| `MYRMIDON_CORPUS_PARSER_BASE_URL` · `MYRMIDON_CORPUS_PARSER_TIMEOUT_MS` | CORPUS-2.0 C | не задана · `60000` | Как проход разбора доходит до сервиса разбора PDF/сканов (отдельный HTTP-сервис, см. контракт портов): у base URL умолчания нет — без него задание падает с `corpus_parser_unconfigured` и возвращается в очередь, так что включённый корпус без парсера не разбирает документы наполовину | Base URL не задан — звонить некуда, задание уходит в очередь, причина в логе. Таймаут: не число или отрицательный — умолчание |
| `MYRMIDON_CORPUS_EMBEDDER_MODEL` · `_DIMENSIONS` · `_BASE_URL` | CORPUS-2.0 C | `text-embedding-v4` · `1024` · не задана (шлюз LiteLLM компании) | Эмбеддер, которым пишется индекс: имя модели, размерность вектора (HNSW в пилоте построен под 1024) и base URL шлюза, если развёртывание роутит эмбеддинги в другое место | Модель/размерность: не заданы или некорректны — умолчания; нестандартная размерность должна совпасть со схемой индекса, иначе запись падает громко |
| `MYRMIDON_CORPUS_MAX_DOCUMENT_BYTES` · `_MAX_DOCUMENTS_PER_DATASET` | CORPUS-2.0 C | `26214400` (25 МБ) · `1000` | Потолки загрузки: файл больше — отказ 413 `document_too_large` до того, как байты дойдут до BlobStore; датасет на потолке документов отвечает 409 `dataset_full`. Оба потолка правятся под инстанс, а не под датасет | `0` или отрицательное — умолчание; потолки нельзя выключить, можно только поднять |
| `MYRMIDON_CORPUS_PARSE_CONCURRENCY` · `_MAX_PARSE_ATTEMPTS` | CORPUS-2.0 C | `2` · `3` | Сколько документов проход берёт за раз и сколько раз повторяется упавший разбор, прежде чем документ станет `failed` с причиной парсера в `error`. Вместе с периодом прохода это ограничивает нагрузку включённого корпуса на сервис разбора | Не положительное или не число — умолчание. Потолок повторов `1` — «без повторов»; выключить сам потолок нельзя |
| `MYRMIDON_CORPUS_SEARCH_TOP_K` | CORPUS-2.0 C | `5` | Сколько чанков возвращает поиск, если запрос не назвал лимит. Ранжирование (гибрид vector+FTS) делает индекс за портом `SearchIndex`; значение только ограничивает страницу | Тело запроса важнее; значения вне диапазона откатываются к умолчанию |

## divergence-new

### 1.6.6 — CORPUS-2.0 C: серверная часть корпуса знаний

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| CORPUS-2.0-C | Модуль корпуса знаний на сервере доски: HTTP API датасетов, документов, статуса заданий разбора, удаления документа, поиска (прокси к порту `SearchIndex`) и статистики; аддитивный блок `corpus` в `instance_settings.general` (одиннадцать полей; env — умолчание при первом сохранении, дальше истина в сохранённом блоке, аудит записи по компаниям); воркер разбора отдельным проходом доски: забирает задания очереди, разбирает через порт парсера, индексирует чанки, закрывает документ `ready`, при сбое возвращает в очередь до `maxParseAttempts`, затем `failed`; выключенный модуль и процесс без подключённых портов — no-op (проход ничего не забирает, API отвечает 503) | Наши файлы: `server/src/myrmidon/corpus/{ports,service,worker,routes,index}.ts`, `server/src/myrmidon/corpus/corpus.myrmidon.test.ts`, `packages/shared/src/myrmidon-corpus.ts`, `docs/myrmidon/changes/ope-6165-corpus-server.md`; в вендоре помечены `myrmidon(1.6.6 CORPUS-2.0 ч.C)`: `packages/shared/src/index.ts` (строка экспорта), `packages/shared/src/validators/instance.ts` (поле `corpus`), `server/src/services/instance-settings.ts` (проброс ключа), `server/src/app.ts` (импорт + монтирование маршрутов), `server/src/index.ts` (импорт + постановка прохода разбора). Порты берутся из пакета `packages/corpus` (часть A): до его мержа — локальная копия в `server/src/myrmidon/corpus/ports.ts`, заменяется на импорт из пакета | Эпик OPE-4998, решение владельца 04.10: свой RAG на TypeScript модулем продукта вместо RAGFlow, за портами CorpusStore / SearchIndex / WorkQueue / BlobStore, включается и настраивается в интерфейсе; часть C — серверная половина (API + настройки + проход разбора) | `server/src/myrmidon/corpus/corpus.myrmidon.test.ts` (выключенный и не подключённый модуль молчит: ни одного обращения к портам, 503 на данных, настройки читаются; round-trip блока из одиннадцати полей через сохранённый JSON без потерь; откат по полю при мусоре в сохранённой строке; права: PATCH только админ инстанса, доступ к компании — первым; датасеты и документы в границах компании; загрузка файла в BlobStore и очередь, разбор до `ready` на проходе, поиск отдаёт чанк; повтор сбоя до потолка попыток, затем `failed`; потолки размера файла и числа документов) | Никогда, наше поведение; уходит вместе с модулем корпуса. Снятие: удалить каталог `server/src/myrmidon/corpus/`, `packages/shared/src/myrmidon-corpus.ts`, поле `corpus` из общей схемы и проброс в сервисе настроек, строки с меткой в `server/src/app.ts` и `server/src/index.ts`, каталог `packages/corpus` | (этот PR) |