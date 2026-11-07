## changelog-en

### Corpus: documents by address, refreshed on a schedule (1.6.6 CORPUS, OPE-12000)

- New `POST /api/myrmidon/companies/:companyId/corpus/datasets/:datasetId/documents/url` with
  `{url, refreshIntervalHours?, name?}` adds a document by address. The board downloads the page
  (http/https on port 80 or 443 only, 30 s deadline, the same `maxDocumentBytes` ceiling as an upload, enforced
  on the decoded stream), stores it as an ordinary document on the road an upload takes (BlobStore, parse job,
  audit action `myrmidon.corpus.document_uploaded` with `sourceUrl`), and answers `202 {document, job}`. The
  document remembers `sourceUrl`, `refreshIntervalHours` (168 hours unless given; 1 to 8760), `contentHash`
  (SHA-256) and `lastFetchedAt`; they appear on every document the corpus API returns, together with
  `sourceError`. The same address in one dataset is refused with `409 source_url_exists`, also when two
  requests for it arrive at the same time (one document is made).
- The download goes through the board's guarded transport (the one outbound MCP and OAuth calls use): the host
  name is resolved once, every address must be public, the socket is dialled at an approved address, and the
  peer address is checked again before a request byte is written, so a rebinding name server gets nothing.
  Loopback, private, link-local and cloud-metadata addresses, `localhost`, other ports, `file:`/`ftp:` addresses
  and addresses with a user name or password are refused with `422 source_url_blocked` / `source_url_invalid`
  before any document is created. Redirects are followed by the board itself, up to 5, each hop through the
  whole guard again. A failed download is answered with a fixed text (`502 source_fetch_failed`): what the
  socket or the resolver said goes to the log only. All downloads of the board (the hourly sweep, a manual
  refresh, an add by address) share one limit of 4 at a time.
- Documents added by address are kept current by the product: once an hour (on the scheduler tick, behind the
  corpus switch, a no-op while the module is off) the board fetches the ones whose interval has passed. The same
  hash only moves `lastFetchedAt`, except for a `failed` document, which is parsed again from the bytes it
  holds. A new hash stores the new bytes and queues a new parse job (the document goes back to `queued`; the
  parse of the new version replaces the old chunks, and the old bytes are removed once the new version is
  `ready`). A failed download leaves the stored version untouched and records a short code in `sourceError`;
  a document still being parsed is skipped. A replaced document is audited as `myrmidon.corpus.document_refreshed`.
- New `POST /api/myrmidon/companies/:companyId/corpus/datasets/:datasetId/refresh-urls`: starts fetching every
  URL-sourced document of the dataset now, whatever its interval, and answers `202 {datasetId, started, documents}`
  at once. The run goes on in the background, one at a time per dataset (`409 refresh_in_progress`), with a pause of
  60 s after the end of a run (`429 refresh_too_soon`, with `Retry-After`). The start is audited as
  `myrmidon.corpus.refresh_started`, the end, with the counters `{checked, unchanged, updated, skipped, failed,
  failures[]}`, as `myrmidon.corpus.refresh_completed`.
- No migration: `source_uri` and `content_hash` of `corpus_documents` already exist, and the interval and fetch
  bookkeeping live in its `metadata` (a document counts as "by address" only when it carries the interval, so the
  RAGFlow importer's provenance in `source_uri` is never fetched). Both new routes need the same company access as an upload.

## changelog-ru

### Корпус: документы по адресу с обновлением по расписанию (1.6.6 CORPUS, OPE-12000)

- Новый `POST /api/myrmidon/companies/:companyId/corpus/datasets/:datasetId/documents/url` с телом
  `{url, refreshIntervalHours?, name?}` добавляет документ по адресу. Доска скачивает страницу (только
  http/https на порту 80 или 443, срок 30 с, тот же потолок `maxDocumentBytes`, что у загрузки, — он проверяется
  на распакованном потоке), сохраняет её обычным документом тем же путём, что загрузку файла (BlobStore, задание
  разбора, действие аудита `myrmidon.corpus.document_uploaded` с `sourceUrl`) и отвечает `202 {document, job}`.
  Документ помнит `sourceUrl`, `refreshIntervalHours` (168 часов, если не задано; от 1 до 8760), `contentHash`
  (SHA-256) и `lastFetchedAt`; они видны в каждом документе, который отдаёт API корпуса, вместе с `sourceError`.
  Тот же адрес в одном наборе отклоняется кодом `409 source_url_exists`, в том числе когда два запроса с ним
  приходят одновременно (создаётся один документ).
- Скачивание идёт через защищённый транспорт доски (тот же, что у исходящих вызовов MCP и OAuth): имя хоста
  разрешается один раз, все адреса должны быть публичными, сокет открывается на одобренный адрес, а адрес
  собеседника проверяется ещё раз до отправки первого байта запроса, так что подменяющий DNS-сервер ничего не
  добьётся. Loopback, частные, link-local и адрес метаданных облака, `localhost`, другие порты, адреса
  `file:`/`ftp:` и адреса с логином или паролем отклоняются кодами `422 source_url_blocked` /
  `source_url_invalid` до создания документа. Перенаправления доска проходит сама, не более 5, каждый переход
  снова через всю защиту. Неудачное скачивание отвечает фиксированным текстом (`502 source_fetch_failed`): что
  сказал сокет или резолвер, попадает только в журнал. Все скачивания доски (почасовой проход, ручное
  обновление, добавление по адресу) делят один предел — 4 одновременно.
- Документы по адресу продукт обновляет сам: раз в час (на такте планировщика, за переключателем корпуса, при
  выключенном модуле — пустой проход) доска скачивает те, у кого срок вышел. Тот же хеш двигает только
  `lastFetchedAt`, кроме документа в `failed`: его разбирают заново из байтов, которые он хранит. Новый хеш
  сохраняет новые байты и ставит новое задание разбора (документ возвращается в `queued`; разбор новой версии
  заменяет старые чанки, а старые байты удаляются, когда новая версия станет `ready`). Неудачное скачивание
  оставляет сохранённую версию как есть и пишет короткий код в `sourceError`; документ, который ещё разбирается,
  пропускается. Заменённый документ пишется в аудит как `myrmidon.corpus.document_refreshed`.
- Новый `POST /api/myrmidon/companies/:companyId/corpus/datasets/:datasetId/refresh-urls`: запускает скачивание
  всех документов набора, добавленных по адресу, сейчас, независимо от срока, и сразу отвечает
  `202 {datasetId, started, documents}`. Запуск идёт в фоне, по одному на набор (`409 refresh_in_progress`), с
  паузой 60 с после конца запуска (`429 refresh_too_soon`, с заголовком `Retry-After`). Начало пишется в аудит как
  `myrmidon.corpus.refresh_started`, конец со счётчиками `{checked, unchanged, updated, skipped, failed,
  failures[]}` — как `myrmidon.corpus.refresh_completed`.
- Миграции нет: `source_uri` и `content_hash` в `corpus_documents` уже есть, а срок и учёт скачиваний лежат в её
  `metadata` (документ считается «по адресу», только если у него есть срок, поэтому происхождение из RAGFlow в
  `source_uri` никогда не скачивается). Оба новых маршрута требуют тех же прав на компанию, что и загрузка.
