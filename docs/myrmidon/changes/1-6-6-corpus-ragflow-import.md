## changelog-en

### Import pre-parsed RAGFlow chunks into the company corpus (1.6.6 CORPUS-2.0)

- The resumable corpus importer copies RAGFlow dataset, document and chunk metadata without parsing source files again, checks source counts before writes or embeddings, and reports new (`embedded`) and reused vectors separately. The operator guide documents the required bge-m3/1024 model alignment, secure environment, preflight, resume and acceptance steps.

## changelog-ru

### Импорт готовых чанков RAGFlow в корпус компании (1.6.6 CORPUS-2.0)

- Возобновляемый импортёр копирует метаданные датасетов, документов и чанков RAGFlow без повторного разбора файлов, сверяет числа с источником до записи и эмбеддинга, отдельно показывает новые (`embedded`) и повторно использованные (`reused`) векторы. Руководство оператора описывает согласование bge-m3/1024, безопасное окружение, preflight, возобновление и приёмку.
