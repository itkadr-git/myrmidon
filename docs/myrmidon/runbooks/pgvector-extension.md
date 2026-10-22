# Векторное расширение в базе доски (pgvector)

Ручной ранбук: тревоги-ключа у него нет, в реестр алертов он не попадает и задачу сам не
открывает. Владелец — роль `devops` (оператор доски).

Модуль корпуса знаний (1.6.6) хранит эмбеддинги в колонке типа `vector`, поэтому в базе доски
должно быть включено расширение `vector` — pgvector. Одного того, что расширение *доступно* в
образе, мало: нужно, чтобы оно было включено в самой базе. Признак готовности — запрос
`SELECT extversion FROM pg_extension WHERE extname='vector'` возвращает `0.8.7`.

Что уже сделано за вас:

- Свежая установка (`scripts/myrmidon/install/install.sh`) поднимает базу на образе
  `pgvector/pgvector:0.8.7-pg17` и сама выполняет `CREATE EXTENSION IF NOT EXISTS vector;` до
  старта доски. На такой установке ничего делать не нужно.
- Боевой кластер на vm-core уже переведён на pgvector-образ, расширение там включено.
- Этот ранбук — про **существующие** установки, где расширения ещё нет.

## Как понять, какой у вас случай

1. Образ базы:

   ```sh
   docker inspect --format '{{.Config.Image}}' myrmidon-db-1     # установка из install.sh
   podman inspect --format '{{.ImageName}}' paperclip-db         # установка systemd/quadlet
   ```

   Если ответ начинается с `pgvector/pgvector:` — у вас случай 1.
   Если ответ `postgres:17-alpine` (или любой другой `postgres:*` без pgvector) — случай 2.

2. Включено ли расширение:

   ```sh
   docker exec -i myrmidon-db-1 psql -U paperclip -d paperclip \
     -c "SELECT extversion FROM pg_extension WHERE extname='vector';"
   ```

   Пусто (`0 rows`) — расширения нет; `0.8.7` — всё уже включено, делать нечего.

## Случай 1: образ базы умеет pgvector

Замена образа и кластера не требуется — расширение ставится одной командой в работающей базе:

```sh
docker exec -i myrmidon-db-1 psql -U paperclip -d paperclip \
  -c 'CREATE EXTENSION IF NOT EXISTS vector;'
docker exec -i myrmidon-db-1 psql -U paperclip -d paperclip \
  -c "SELECT extversion FROM pg_extension WHERE extname='vector';"        # 0.8.7
docker exec -i myrmidon-db-1 psql -U paperclip -d paperclip \
  -c "SELECT '[1,0,0]'::vector <-> '[0,1,0]'::vector AS distance;"        # ~1.414
curl -fsS http://127.0.0.1:3100/api/health                                # status ok
```

Команда идемпотентна: повторный запуск ничего не меняет. Перезапуск доски не нужен — расширение
живёт в самой базе и видно любому следующему подключению.

## Случай 2: база на чистом `postgres:17-alpine`

В этом образе бинарника расширения нет вовсе: `CREATE EXTENSION vector` падает с
`could not open extension control file ".../vector.control": No such file or directory`.
Одной командой случай не закрывается — нужен переход на pgvector-образ **с переносом данных**.

**Подмена образа на месте, на том же кластере, запрещена.** `postgres:17-alpine` — сборка на musl,
`pgvector/pgvector:*` — на glibc: кластер инициализирован в другом окружении, и PostgreSQL об этом
не предупредит; индексы по тексту после такой подмены могут разойтись с данными. Автоматический
откат обновления образ базы тоже не вернёт — установщик пишет строку образа безусловно. Переход
делается окном обслуживания с дампом и восстановлением.

Порядок для установки из `install.sh` (каталог `/opt/myrmidon`):

1. Объявить окно, предупредить пользователей. Данные доски (`paperclip-data`) перенос не трогает,
   терять их не нужно.
2. Снять дамп со старого кластера, пока он ещё работает на прежнем образе:

   ```sh
   cd /opt/myrmidon
   docker compose --env-file deploy.env exec -T db pg_dump -U paperclip -Fc paperclip \
     > /root/myrmidon-$(date -u +%Y%m%dT%H%M%SZ).dump
   ls -l /root/myrmidon-*.dump        # дамп должен быть непустым
   ```

   Скопируйте дамп за пределы хоста — это единственная копия данных на время переноса.
3. Остановить стек: `docker compose --env-file deploy.env down`
4. Поднять чистый кластер на pgvector-образе и восстановить в него дамп. Пароль роли берётся из
   `deploy.env` — `pg_dump` роли не переносит, и с другим паролем доска к базе не подключится:

   ```sh
   set -a; . /opt/myrmidon/deploy.env; set +a
   docker volume rm myrmidon_pgdata                    # старый кластер; дамп уже снят (шаг 2)
   docker run -d --name myrmidon-restore \
     -e POSTGRES_USER="$POSTGRES_USER" -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
     -e POSTGRES_DB="$POSTGRES_DB" \
     -v myrmidon_pgdata:/var/lib/postgresql/data \
     pgvector/pgvector:0.8.7-pg17
   until docker exec myrmidon-restore pg_isready -U "$POSTGRES_USER" >/dev/null 2>&1; do sleep 2; done
   docker exec -i myrmidon-restore pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
     --clean --if-exists < /root/myrmidon-<метка>.dump
   docker exec -i myrmidon-restore psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
     -c 'CREATE EXTENSION IF NOT EXISTS vector;'
   docker rm -f myrmidon-restore                       # данные остаются в томе myrmidon_pgdata
   ```

5. Перевести саму установку на pgvector-образ: в `/opt/myrmidon/compose.yml` заменить строку
   `image: postgres:17-alpine` в сервисе `db` на `image: pgvector/pgvector:0.8.7-pg17` и поднять
   стек:

   ```sh
   cd /opt/myrmidon && docker compose --env-file deploy.env up -d
   ```

   Установщик со следующего обновления пишет эту строку сам; при повторном запуске на той же
   версии выпуска он файл не перезаписывает.
6. Проверить: `SELECT extversion …` = `0.8.7`, `curl -fsS http://127.0.0.1:3100/api/health` —
   `status ok`, данные доски на месте (открыть интерфейс, посмотреть задачи).

### Повторный запуск установщика на такой установке

`install.sh` перезаписывает `compose.yml` целиком, в том числе строку образа базы. Запуск
установщика на установке, которая ещё живёт на `postgres:17-alpine`, делает ту самую подмену
образа на месте, которую этот ранбук запрещает. Поэтому: **сначала перенос из случая 2, потом
обновления установщиком.** Если дамп снят, но перенос не закончен — вернуть старый образ в
`compose.yml` и запускать установщик только после восстановления.

### Установка через systemd/quadlet

Порядок тот же, инструменты — `podman`, службы `paperclip-db`, том `paperclip-pgdata`
(`doc/DOCKER.md`): дамп `podman exec -i paperclip-db pg_dump …`, остановка `systemctl --user stop
paperclip.service`, чистый том, восстановление и правка `Image=` в
`docker/quadlet/paperclip-db.container`. Строку образа в юните без переноса данных не менять.

## Если не помогло

- `CREATE EXTENSION` отвечает `permission denied` — команду надо выполнять ролью-владельцем базы
  (`paperclip`), а не суперпользователем чужого кластера; проверьте `-U`.
- `could not open extension control file` после переноса — контейнер поднят на не-pgvector образе:
  `docker inspect --format '{{.Config.Image}}' myrmidon-db-1` покажет, какой образ работает на самом
  деле, и строка образа в `compose.yml`/юните должна с ним совпадать.
- Расширение включилось, а модуль корпуса молчит — проверьте, что доска действительно на выпуске
  1.6.6 и новее (`/api/health`, версия в интерфейсе): до 1.6.6 векторного поиска в ней нет.
- Тревога по метрике или отказ доски после переноса — не гадайте: верните прежний том из дампа
  шага 2 и заведите задачу на разбор с журналами `docker compose logs db` и `logs server`.
- Боевые стенды и боевой кластер vm-core этот ранбук не трогает: там перенос уже сделан
  оператором, повторять его не нужно.