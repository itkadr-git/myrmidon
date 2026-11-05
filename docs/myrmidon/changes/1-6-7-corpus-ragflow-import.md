## changelog-en

### Continue RAGFlow corpus import after partial document failures (1.6.7)

- Preserve available chunks from failed RAGFlow documents, report partial document IDs, and list documents without chunks instead of creating empty corpus rows.
- Optionally upload unparsed source files through the normal corpus parser when `CORPUS_IMPORT_UPLOAD_UNPARSED=1` is enabled.

## changelog-ru

### Продолжение импорта корпуса RAGFlow после частичных ошибок документов (1.6.7)

- Сохраняет доступные чанки документов RAGFlow со статусом FAIL, сообщает идентификаторы частичных документов и перечисляет документы без чанков вместо создания пустых строк корпуса.
- При `CORPUS_IMPORT_UPLOAD_UNPARSED=1` исходные файлы неразобранных документов можно передать штатному парсеру корпуса.
