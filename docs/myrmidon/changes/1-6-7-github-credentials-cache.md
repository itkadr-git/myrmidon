---
settings-section: Track 5 — operations
---

## changelog-en

### GitHub credentials cache, single-flight resolution, and per-run request fuse (OPE-12446)

- The GitHub operation credentials broker caches minted installation tokens in-memory for 50 minutes per company, agent, run, and repository, preventing duplicate token minting against the GitHub App hourly installation limit.
- Concurrent requests for the same repository and context join a single-flight token resolution promise, minting exactly one token from GitHub.
- Bot runtime launcher configures run-scoped credentials disk cache via `PAPERCLIP_GITHUB_CREDENTIALS_CACHE_DIR` with 45-minute TTL and 0600 file permissions, eliminating repeated HTTP credentials requests from git and gh CLI invocations.
- Per-run request fuse rejects runaway credentials requests exceeding `MYRMIDON_GITHUB_CREDENTIALS_FUSE_PER_MINUTE` (default 60/min, rolling 60s window) with HTTP 429 Too Many Requests.

## changelog-ru

### Кэширование учетных данных GitHub, single-flight дедупликация и предохранитель частоты запросов прогона (OPE-12446)

- Брокер учетных данных GitHub кэширует выпущенные токены установки в оперативной памяти на 50 минут по ключу компании, агента, прогона и репозитория, предотвращая повторный выпуск токенов и исчерпание почасового лимита GitHub App.
- Параллельные запросы токена для одного репозитория объединяются в единый in-flight промис (single-flight), выполняя ровно один запрос к GitHub.
- Лаунчер среды выполнения бота настраивает дисковый кэш токенов через `PAPERCLIP_GITHUB_CREDENTIALS_CACHE_DIR` с TTL 45 минут и правами 0600, устраняя избыточные HTTP-запросы к брокеру при каждом вызове git и gh CLI.
- Предохранитель запросов прогона блокирует аномально частые обращения свыше `MYRMIDON_GITHUB_CREDENTIALS_FUSE_PER_MINUTE` (по умолчанию 60/мин в скользящем окне 60 с) с кодом ошибки HTTP 429 Too Many Requests.

## settings-en

| `MYRMIDON_GITHUB_CREDENTIALS_FUSE_PER_MINUTE` | OPE-12446 | `60` | Maximum allowed GitHub credential requests per minute from a single run before the broker trips the request fuse with HTTP 429. Setting a non-positive value (`<= 0`) resets to default (60). Legacy alias: `PAPERCLIP_GITHUB_CREDENTIALS_FUSE_PER_MINUTE`. | Increase if high-concurrency multi-module operations legitimately exceed 60 req/min from a single run. |

## settings-ru

| `MYRMIDON_GITHUB_CREDENTIALS_FUSE_PER_MINUTE` | OPE-12446 | `60` | Максимальное число запросов учетных данных GitHub в минуту от одного прогона до срабатывания предохранителя с HTTP 429. Неположительное значение (`<= 0`) возвращает умолчание (60). Устаревший псевдоним: `PAPERCLIP_GITHUB_CREDENTIALS_FUSE_PER_MINUTE`. | Увеличьте, если параллельные массовые операции обоснованно требуют более 60 запросов в минуту от одного прогона. |
