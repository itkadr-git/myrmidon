## changelog-en

### Corpus reports clear error when embedder is not configured (1.6.7 CORPUS)

- Uploading documents and executing semantic searches in a company without an embedder
  (missing secret `MYRMIDON_CORPUS_EMBEDDER_API_KEY` and no `embedderBaseUrl`) now rejects
  with HTTP 422 `corpus_embedder_not_configured` accompanied by a actionable hint.
- Uploaded documents without an available embedder are marked with status `failed` and
  record `corpus_embedder_not_configured` as their failure reason.

## changelog-ru

### Корпус возвращает понятную ошибку, если эмбеддер не настроен (1.6.7 CORPUS)

- Загрузка документов и семантический поиск в компании без настроенного эмбеддера
  (отсутствует секрет компании `MYRMIDON_CORPUS_EMBEDDER_API_KEY` и не задан `embedderBaseUrl`)
  теперь отклоняются с кодом HTTP 422 `corpus_embedder_not_configured` и подсказкой.
- При попытке загрузки в компании без эмбеддера созданный документ сразу переводится в
  статус `failed` с причиной ошибки `corpus_embedder_not_configured`.
