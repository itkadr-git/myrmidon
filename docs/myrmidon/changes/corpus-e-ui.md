---
divergence-section: 1.6.6 — CORPUS-2.0: экран «Корпус» (часть E, интерфейс)
---

## changelog-en

### The knowledge corpus has a screen (1.6.6 CORPUS, part E — web)

- Company Settings has a new **Knowledge corpus** section
  (`/company/settings/corpus`): the module switch, the settings of the module
  (address of the document-parsing service, embedder model, upload, document and
  chunk limits) and the datasets with their documents and a trial search.
- The settings are written back as one object, so fields the screen does not
  edit survive a save. The whole object is read back after a save instead of
  being assumed.
- Datasets can be created and deleted; each dataset lists its documents with the
  parse status (`queued` / `parsing` / `embedding` / `ready` / `failed`). While a
  document is still moving the list refreshes itself, so `ready` appears without
  a page reload. A file can be uploaded, a `failed` document retried and any
  document deleted.
- Trial search runs a query over the open dataset and shows the top-k chunks with
  their score and the document they came from.
- With the module switched off the screen says so and offers no parsing,
  embedding or search; a server that does not serve the corpus routes at all
  shows the screen as unavailable.

## changelog-ru

### У корпуса знаний появился свой экран (1.6.6 CORPUS, часть E — web)

- В настройках компании появился раздел **Корпус**
  (`/company/settings/corpus`): переключатель модуля, настройки модуля (адрес
  сервиса разбора документов, модель эмбеддера, лимиты загрузки, документов и
  фрагментов), датасеты с документами и пробный поиск.
- Настройки сохраняются одним объектом, поэтому поля, которых экран не
  редактирует, при сохранении не теряются. После сохранения объект
  перечитывается, а не считается записанным на веру.
- Датасеты можно создавать и удалять; каждый датасет показывает свои документы
  со статусом разбора (`queued` / `parsing` / `embedding` / `ready` / `failed`).
  Пока документ в работе, список обновляется сам, поэтому `ready` появляется без
  перезагрузки страницы. Файл можно загрузить, документ со статусом `failed` —
  повторить, любой документ — удалить.
- Пробный поиск выполняет запрос по открытому датасету и показывает top-k
  фрагментов с оценкой и ссылкой на документ.
- При выключенном модуле экран сообщает об этом и не предлагает разбор,
  эмбеддинги и поиск; сервер, который вовсе не отдаёт маршруты корпуса,
  показывается как недоступный.

## divergence-new

### 1.6.6 — CORPUS-2.0: экран «Корпус» (часть E, интерфейс)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-CORPUS-E-UI | Экран «Корпус» в настройках компании (`/company/settings/corpus`, пункт в `CompanySettingsNav` после «Owner Telegram delivery»): переключатель модуля, настройки (адрес сервиса разбора, модель эмбеддера, лимиты загрузки/документов/фрагментов) с сохранением одним объектом и перечитыванием ответа, датасеты (создание, удаление), документы открытого датасета со статусами разбора (`queued`/`parsing`/`embedding`/`ready`/`failed`), живое обновление списка, пока документ не терминален, загрузка файла, повтор `failed`, удаление, пробный гибридный поиск по датасету (top-k фрагментов с оценкой и ссылкой на документ). При выключенном флаге `enabled` действия разбора/поиска заблокированы, а переключатель остаётся доступным; сервер без маршрутов корпуса (404/501/503 на чтение настроек) показывается состоянием «модуль недоступен». Контракт — часть C (`/api/myrmidon/companies/:companyId/corpus/...`); до её мержа типы и пути живут локальной копией в `corpusApi.ts`, тесты мокают контракт | Наши файлы: `ui/src/components/myrmidon/corpus/{corpusApi.ts,corpusConfig.ts,CorpusScreen.tsx,CorpusScreenContainer.tsx}` и три теста (`CorpusScreen.myrmidon.test.tsx`, `CorpusScreenContainer.myrmidon.test.tsx`, `corpusApi.myrmidon.test.tsx`); в вендоре помечены `myrmidon(1.6.6 CORPUS E)`: `ui/src/App.tsx` (импорт и маршрут), `ui/src/components/access/CompanySettingsNav.tsx` (пункт меню, активная секция, ключ подписи) и его тест, `ui/src/i18n/myrmidon-locales/{en,ru}.json` (раздел `corpus` и подпись `settingsNav.corpus`) | Модуль корпуса (эпик OPE-4998, шаг 4 — OPE-6165) включается и настраивается из интерфейса; без экрана включить модуль, завести датасет, загрузить документ и проверить поиск можно было только запросами к API | `CorpusScreen.myrmidon.test.tsx` (view-ярус: настройки в полях, блокировка действий при выключенном модуле, состояние «недоступен», список документов со статусами, вывод попаданий поиска, ошибки), `CorpusScreenContainer.myrmidon.test.tsx` (wire-ярус: загрузка настроек/датасетов/документов, отсутствие маршрутов — «недоступен» без запросов к датасетам, round-trip сохранения целым объектом с перечитыванием, создание и удаление датасета, отмена удаления, загрузка файла, повтор и удаление документа, поиск с сохранённым top-k, ошибки), `corpusApi.myrmidon.test.tsx` (клиент-ярус: замороженные пути, полное тело PUT, multipart загрузки, тело поиска, экранирование id, ключи кэша, опрос только при нетерминальных статусах) | Никогда, наше поведение; снимается вместе с частями A–D (модуль корпуса). Снимать: удалить каталог `ui/src/components/myrmidon/corpus`, пункт навигации, маршрут, ключ подписи и раздел `corpus` в каталогах локалей по меткам `myrmidon(1.6.6 CORPUS E)` | (этот PR) |

## settings-en-new

<!-- after: REVIEW-ROUTING: automatic reviewer for tasks in review -->

### 1.6.6 — CORPUS: the knowledge corpus module (part E, the screen)

Settings of the knowledge-corpus module (epic OPE-4998, step 4 — OPE-6165; part E is the
screen, part C owns the server side of the contract). The module has no environment
variables: the values are a company policy, read and written by the Company Settings →
Knowledge corpus screen through
`GET`/`PUT /api/myrmidon/companies/:companyId/corpus/settings`. The screen writes the whole
object back, so a field it does not edit is not lost. Where the object is stored and what a
missing object means is part C's; the screen shows what the module returns.

| Field | Default | What it does | How to disable / special |
|---|---|---|---|
| `enabled` | from the module | Master switch of the module: parsing, embedding and search run only while it is on | `false` — the screen keeps the settings and the datasets reachable, blocks upload / retry / search and says the module is off; a server that serves no corpus routes at all is shown as unavailable |
| `parsingServiceBaseUrl` | from the module | Base URL of the separate document-parsing HTTP service; documents stay `queued` until it answers | An empty field — parsing is not configured |
| `embedderModel` | from the module | Embedder model name used through the company model gateway | Not empty |
| `limits.maxUploadMb` | from the module | Largest single upload, in megabytes | 1 to 200 |
| `limits.maxDocumentsPerDataset` | from the module | Documents one dataset may hold | 1 to 10000 |
| `limits.searchTopK` | from the module | Chunks a trial search (and agent search by default) returns | 1 to 50 |

How a dataset is managed from the screen. Datasets are created by name (up to 64 characters, a
new dataset opens at once) and deleted after a confirmation; each lists its documents with the
parse status (`queued`, `parsing`, `embedding`, `ready`, `failed`) and the list refreshes itself
every 4 s while a document is not terminal, so `ready` appears without a reload. A document is
uploaded as a file into the open dataset, a `failed` document is retried, and any document is
deleted after a confirmation. The trial search sends the query with the stored `searchTopK` and
lists the chunks with their score and the document they came from.

## settings-ru-new

<!-- after: 1.6.1 — WIP-LIMIT: лимит задач в работе на агента -->

### 1.6.6 — CORPUS: модуль корпуса знаний (часть E, экран)

Настройки модуля корпуса знаний (эпик OPE-4998, шаг 4 — OPE-6165; часть E — экран, серверную
часть контракта владеет часть C). У модуля нет переменных окружения: значения — это политика
компании, которую читает и записывает экран «Корпус» в настройках компании через
`GET`/`PUT /api/myrmidon/companies/:companyId/corpus/settings`. Экран записывает объект целиком,
поэтому поле, которое он не редактирует, не теряется. Где объект хранится и что означает его
отсутствие — часть C; экран показывает то, что вернул модуль.

| Поле | По умолчанию | Что делает | Как выключить / особенности |
|---|---|---|---|
| `enabled` | из модуля | Главный переключатель модуля: разбор, построение эмбеддингов и поиск работают, только пока он включён | `false` — экран оставляет доступными настройки и датасеты, блокирует загрузку, повтор и поиск и сообщает, что модуль выключен; сервер, который вовсе не отдаёт маршруты корпуса, показывается как недоступный |
| `parsingServiceBaseUrl` | из модуля | Базовый адрес отдельного сервиса разбора документов по HTTP; до его ответа документы остаются в `queued` | Пустое поле — разбор не настроен |
| `embedderModel` | из модуля | Имя модели эмбеддера, вызываемой через шлюз моделей компании | Не пустое |
| `limits.maxUploadMb` | из модуля | Максимальный размер одной загрузки, в мегабайтах | От 1 до 200 |
| `limits.maxDocumentsPerDataset` | из модуля | Сколько документов может хранить один датасет | От 1 до 10000 |
| `limits.searchTopK` | из модуля | Сколько фрагментов возвращает пробный поиск (и поиск агентов по умолчанию) | От 1 до 50 |

Как экран управляет датасетом. Датасеты создаются по имени (до 64 символов, новый датасет
открывается сразу) и удаляются после подтверждения; каждый показывает свои документы со
статусом разбора (`queued`, `parsing`, `embedding`, `ready`, `failed`), и пока документ не
терминален, список обновляется сам каждые 4 с, поэтому `ready` появляется без перезагрузки.
Документ загружается файлом в открытый датасет, документ со статусом `failed` повторяется,
любой документ удаляется после подтверждения. Пробный поиск отправляет запрос с сохранённым
`searchTopK` и показывает фрагменты с оценкой и ссылкой на документ.