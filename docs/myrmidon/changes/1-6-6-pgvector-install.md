## changelog-en

### The board database ships pgvector, and a fresh install switches the extension on (CORPUS-2.0 step 4)

- The board database image is now `pgvector/pgvector:0.8.7-pg17` in both the
  installer's generated compose and `docker/docker-compose.yml`, replacing
  `postgres:17-alpine`. The module of the knowledge corpus keeps its embeddings
  in a `vector` column, so the extension binary has to be in the image the
  database runs.
- The binary alone is not enough: the installer now enables the extension in
  the board database right after the database becomes healthy and before the
  board starts, checks the version the database reports and prints it. A version
  other than `0.8.7` fails the installation instead of leaving a board whose
  corpus cannot index. Immediately after a fresh install
  `SELECT extversion FROM pg_extension WHERE extname='vector'` returns
  `0.8.7` — the same version as the pilot and the production cluster.
  Re-running the installer is unchanged: the step is idempotent
  (`CREATE EXTENSION IF NOT EXISTS`) and only runs on a fresh install.
- Boards already installed on `postgres:17-alpine` keep the old image until
  their operator enables the extension by hand: the runbook
  [runbooks/pgvector-extension.md](runbooks/pgvector-extension.md) covers both
  cases — an image that already carries pgvector (one `CREATE EXTENSION IF NOT
  EXISTS vector;` in the board database, no image or cluster swap) and a plain
  `postgres:17-alpine` (maintenance window, `pg_dump -Fc`, move to the pgvector
  image, restore; an in-place image swap of a running cluster is not allowed).

## changelog-ru

### База доски едет с pgvector, свежая установка включает расширение сама (CORPUS-2.0, шаг 4)

- Образ базы доски теперь `pgvector/pgvector:0.8.7-pg17` и в генерируемом
  инсталлятором compose, и в `docker/docker-compose.yml` — вместо
  `postgres:17-alpine`. Модуль корпуса знаний держит эмбеддинги в колонке
  `vector`, поэтому бинарник расширения должен быть в образе, на котором
  работает база.
- Одного бинарника мало: инсталлятор теперь включает расширение в базе доски
  сразу после того, как база стала healthy, и до старта доски, сверяет
  версию, которую вернула база, и печатает её. Версия, отличная от `0.8.7`,
  роняет установку — вместо доски, у которой корпус не сможет индексировать.
  Сразу после свежей установки
  `SELECT extversion FROM pg_extension WHERE extname='vector'` возвращает
  `0.8.7` — ту же версию, что в пилоте и на боевом кластере. Повторный прогон
  инсталлятора ничего не меняет: шаг идемпотентен (`CREATE EXTENSION IF NOT
  EXISTS`) и выполняется только при свежей установке.
- Доски, уже установленные на `postgres:17-alpine`, остаются на старом образе,
  пока оператор не включит расширение руками: ранбук
  [runbooks/pgvector-extension.md](runbooks/pgvector-extension.md)
  покрывает оба случая — образ, в котором pgvector уже есть (одна команда
  `CREATE EXTENSION IF NOT EXISTS vector;` в базе доски, замена образа и
  кластера не нужна), и чистый `postgres:17-alpine` (окно обслуживания,
  `pg_dump -Fc`, переезд на pgvector-образ, восстановление дампа; подмена
  образа у работающего кластера на месте запрещена).