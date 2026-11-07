## changelog-en

### Corpus: documents by address, refreshed on a schedule (1.6.6 CORPUS, OPE-12000)

- New `POST /api/myrmidon/companies/:companyId/corpus/datasets/:datasetId/documents/url` with
  `{url, refreshIntervalHours?, name?}` adds a document by address. The board downloads the page
  (http/https only, 30 s deadline, the same `maxDocumentBytes` ceiling as an upload, enforced on the decoded
  stream), stores it as an ordinary document on the road an upload takes (BlobStore, parse job, audit action
  `myrmidon.corpus.document_uploaded` with `sourceUrl`), and answers `202 {document, job}`. The document remembers
  `sourceUrl`, `refreshIntervalHours` (168 hours unless given; 1 to 8760), `contentHash` (SHA-256) and
  `lastFetchedAt`; they appear on every document the corpus API returns, together with `sourceError`. The
  same address twice in one dataset is refused with `409 source_url_exists`.
- The download goes through the board's guarded transport (the one outbound MCP and OAuth calls use): the host
  name is resolved once, every address must be public, the socket is dialled at an approved address, and the
  peer address is checked again before a request byte is written, so a rebinding name server gets nothing.
  Loopback, private, link-local and cloud-metadata addresses, `localhost`, `file:`/`ftp:` addresses and addresses
  with a user name or password are refused with `422 source_url_blocked` / `source_url_invalid` before any
  document is created. Redirects are followed by the board itself, up to 5, each hop through the whole guard again.
- Documents added by address are kept current by the product: once an hour (on the scheduler tick, behind the
  corpus switch, a no-op while the module is off) the board fetches the ones whose interval has passed. The same
  hash only moves `lastFetchedAt`; a new hash replaces the stored bytes, drops the old chunks and the old bytes
  and queues a new parse job (the document goes back to `queued` and is searchable again once it is `ready`). A
  failed fetch leaves the stored version untouched and records the reason in `sourceError`; a document still being
  parsed is skipped. A replaced document is audited as `myrmidon.corpus.document_refreshed`.
- New `POST /api/myrmidon/companies/:companyId/corpus/datasets/:datasetId/refresh-urls`: fetches every
  URL-sourced document of the dataset now, whatever its interval, and answers `202` with the counters
  `{datasetId, checked, unchanged, updated, skipped, failed, failures[]}`.
- No migration: `source_uri` and `content_hash` of `corpus_documents` already exist, and the interval and fetch
  bookkeeping live in its `metadata` (a document counts as "by address" only when it carries the interval, so the
  RAGFlow importer's provenance in `source_uri` is never fetched). Both new routes need the same company access as an upload.

## changelog-ru

### Корпус: документы по адресу с обновлением по расписанию (1.6.6 CORPUS, OPE-12000)

- Новый `POST /api/myrmidon/companies/:companyId/corpus/datasets/:datasetId/documents/url` с телом
  `{url, refreshIntervalHours?, name?}` добавляет документ по адресу. Доска скачивает страницу (только
  http/https, срок 30 с, тот же потолок `maxDocumentBytes`, что у загрузки, — он проверяется на распакованном
  потоке), сохраняет её обычным документом тем же путём, что загрузку файла (BlobStore, задание разбора, действие
  аудита `myrmidon.corpus.document_uploaded` с `sourceUrl`) и отвечает `202 {document, job}`. Документ помнит
  `sourceUrl`, `refreshIntervalHours` (168 часов, если не задано; от 1 до 8760), `contentHash` (SHA-256) и
  `lastFetchedAt`; они видны в каждом документе, который отдаёт API корпуса, вместе с `sourceError`. Тот же адрес
  второй раз в одном наборе отклоняется кодом `409 source_url_exists`.
- Скачивание идёт через защищённый транспорт доски (тот же, что у исходящих вызовов MCP и OAuth): имя хоста
  разрешается один раз, все адреса должны быть публичными, сокет открывается на одобренный адрес, а адрес
  собеседника проверяется ещё раз до отправки первого байта запроса, так что подменяющий DNS-сервер ничего не
  добьётся. Loopback, частные, link-local и адрес метаданных облака, `localhost`, адреса `file:`/`ftp:` и адреса
  с логином или паролем отклоняются кодами `422 source_url_blocked` / `source_url_invalid` до создания документа.
  Перенаправления доска проходит сама, не более 5, каждый переход снова через всю защиту.
- Документы по адресу продукт обновляет сам: раз в час (на такте планировщика, за переключателем корпуса, при
  выключенном модуле — пустой проход) доска скачивает те, у кого срок вышел. Тот же хеш двигает только
  `lastFetchedAt`; новый хеш заменяет сохранённые байты, удаляет старые чанки и старые байты и ставит новое
  задание разбора (документ возвращается в `queued` и снова находится поиском, когда станет `ready`). Неудачное
  скачивание оставляет сохранённую версию как есть и пишет причину в `sourceError`; документ, который ещё
  разбирается, пропускается. Заменённый документ пишется в аудит как `myrmidon.corpus.document_refreshed`.
- Новый `POST /api/myrmidon/companies/:companyId/corpus/datasets/:datasetId/refresh-urls`: скачивает все
  документы набора, добавленные по адресу, сейчас, независимо от срока, и отвечает `202` со счётчиками
  `{datasetId, checked, unchanged, updated, skipped, failed, failures[]}`.
- Миграции нет: `source_uri` и `content_hash` в `corpus_documents` уже есть, а срок и учёт скачиваний лежат в её
  `metadata` (документ считается «по адресу», только если у него есть срок, поэтому происхождение из RAGFlow в
  `source_uri` никогда не скачивается). Оба новых маршрута требуют тех же прав на компанию, что и загрузка.
