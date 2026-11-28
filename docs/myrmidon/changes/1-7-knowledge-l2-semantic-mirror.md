## changelog-en

### Knowledge L-2 RAGFlow semantic mirror

- Optional RAGFlow REST dataset mirror for published knowledge sections, semantic search, and rebuild. Falls back to FTS when the mirror is unavailable.

## changelog-ru

### Семантическое зеркало знаний L-2 в RAGFlow

- Опциональное REST-зеркало опубликованных секций знаний, семантический поиск и пересборка; при недоступности RAGFlow поиск переходит на FTS.

## settings-en-new

### KNOWLEDGE — RAGFlow semantic mirror (1.7)

| Variable | Function | Default | Effect | Disable / notes |
|---|---|---|---|---|
| `MYRMIDON_KNOWLEDGE_RAGFLOW_URL` | KNOWLEDGE L-2 | unset | Base URL of the RAGFlow REST API for the knowledge mirror | Mirror disabled unless this and the API key are set; FTS remains available |
| `MYRMIDON_KNOWLEDGE_RAGFLOW_API_KEY` | KNOWLEDGE L-2 | unset | Server-side RAGFlow API key for dataset operations | Keep secret; do not log or expose to clients. Mirror disabled unless URL is also set |

## settings-ru-new

### KNOWLEDGE — семантическое зеркало RAGFlow (1.7)

| Переменная | Функция | По умолчанию | Что делает | Как выключить / особое |
|---|---|---|---|---|
| `MYRMIDON_KNOWLEDGE_RAGFLOW_URL` | KNOWLEDGE L-2 | не задана | Базовый URL REST API RAGFlow для зеркала знаний | Без URL или ключа зеркало выключено; FTS доступен |
| `MYRMIDON_KNOWLEDGE_RAGFLOW_API_KEY` | KNOWLEDGE L-2 | не задана | Серверный API-ключ RAGFlow для работы с датасетами | Секрет: не выводить в логи или клиенту; без URL зеркало выключено |
