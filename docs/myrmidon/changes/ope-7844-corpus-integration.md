---
settings-section: 1.6.6 — CORPUS-2.0 C: knowledge corpus server side
---

## settings-en

| Configuration | Apply the database migrations and enable pgvector before configuring Corpus. Set the parser URL and embedding model/dimensions for the deployment; leave the embedder base URL unset to use the company LLM gateway. Store credentials only in the approved company secret store. The embedder key comes from the active company secret `MYRMIDON_CORPUS_EMBEDDER_API_KEY`; never put its value in settings or logs. Corpus routes and sweeps remain no-ops while disabled. |
| Verification | Create a dataset, upload a small text document, wait for `ready`, then search a distinctive phrase using REST and MCP `corpus_search`. Confirm both return the same document and MCP `tools/list` includes Corpus tools. Disable Corpus and confirm it does not access DB ports. |

| Variable | Purpose | Default |
| --- | --- | --- |
| `MYRMIDON_CORPUS_EMBEDDER_MODEL` | Embedding model used to build the index | `text-embedding-v4` |
| `MYRMIDON_CORPUS_EMBEDDER_DIMENSIONS` | Vector width; must match the database index schema | `1024` |
| `MYRMIDON_CORPUS_EMBEDDER_BASE_URL` | Optional embedder endpoint; unset uses the company LLM gateway | unset |
| `MYRMIDON_LLM_GATEWAY_BASE_URL` | Optional fallback gateway endpoint used when the Corpus embedder base URL is unset | unset |
| Corpus credential source | The active company secret; never store its value in settings or logs | — |

## settings-ru

| Настройка | Применяйте миграции БД и включите pgvector до настройки Corpus. Укажите URL парсера и модель/размерность эмбеддингов; без base URL эмбеддера используется шлюз LLM компании. Учётные данные храните только в утверждённом хранилище секретов компании. Ключ берётся из активного секрета компании `MYRMIDON_CORPUS_EMBEDDER_API_KEY`; не помещайте его значение в настройки или логи. При выключенном модуле маршруты и обход очереди остаются no-op. |
| Проверка | Создайте датасет, загрузите небольшой текстовый документ, дождитесь `ready`, затем найдите уникальную фразу через REST и MCP `corpus_search`. Убедитесь, что оба интерфейса вернули тот же документ и что MCP `tools/list` содержит Corpus. Выключите Corpus и подтвердите отсутствие обращений к портам БД. |
| Переменная | Назначение | По умолчанию |
| --- | --- | --- |
| `MYRMIDON_CORPUS_EMBEDDER_MODEL` | Модель эмбеддингов для индекса | `text-embedding-v4` |
| `MYRMIDON_CORPUS_EMBEDDER_DIMENSIONS` | Размерность вектора; должна совпадать со схемой индекса БД | `1024` |
| `MYRMIDON_CORPUS_EMBEDDER_BASE_URL` | Необязательный адрес эмбеддера; без него используется шлюз LLM компании | не задан |
| Источник учётных данных корпуса | Активный секрет компании; значение не хранить в настройках или логах | — |
| Документация | Части A–F остаются отдельными задачами техписателя: PR #915 (ядро/схема/порты), #964 (поиск/парсер), #945 (REST/worker), #907 (MCP), #912 (экран настроек Corpus), #946 (pgvector). Это перечень пробелов, а не заявление о готовности документации. | |
