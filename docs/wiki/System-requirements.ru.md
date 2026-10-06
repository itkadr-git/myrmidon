# Системные требования

> English version: [System-requirements](System-requirements)

Что нужно хосту для установки Myrmidon. Значения ниже взяты из документации
продукта и скриптов выката
([`docs/myrmidon/deploy.ru.md`](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/deploy.ru.md),
[`scripts/myrmidon/deploy/deploy.env.example`](https://github.com/itkadr-git/myrmidon/blob/main/scripts/myrmidon/deploy/deploy.env.example)).
Где документы называют число — оно приведено; где не называют — здесь об этом
сказано прямо, а не придумано.

## Программное обеспечение (обязательно)

По документации выката — без этого выкат отказывается работать:

- `bash` 4+
- `docker` с плагинами `compose` и `buildx` (buildx нужен, чтобы прочитать
  digest образа: `docker buildx imagetools inspect`)
- `curl`, `jq`, `git`
- клон репозитория `itkadr-git/myrmidon` на хосте выката, у которого `origin`
  смотрит на `github.com/itkadr-git/myrmidon` — по этому клону скрипт
  проверяет коммит образа
- команда дампа БД (`DUMP_COMMAND`, например `pg_dump`) и, для отката с
  восстановлением, команда восстановления (`RESTORE_COMMAND`, например
  `pg_restore`)

Документация не называет конкретный дистрибутив и версию ОС; подходит любой
Linux, где работает актуальный Docker с плагинами compose и buildx.

## Образы Docker

Доска работает из собранного CI образа `ghcr.io/itkadr-git/myrmidon`, который
публикует workflow **Myrmidon image**. Скрипт выката принимает только образы
CI из `main` или тега `myr-v*` — ни флага, ни настройки для обхода нет.

## База данных

Всё состояние доски живёт в PostgreSQL. Предвыкаточная проверка разворачивает
дамп в одноразовый контейнер Postgres (образ по умолчанию
`postgres:16-alpine`); его старшая версия должна уметь читать дамп, потому что
`pg_restore` отказывает более старому серверу.

## Сеть и порты

- Доска отдаёт интерфейс и API на порту `3100`
  (`HEALTH_URL=http://127.0.0.1:3100/api/health` в примере настроек).
- API обслуживания — на том же порту (`/api/myrmidon/maintenance`).
- В режиме `authenticated` анонимный `/api/health` показывает коммит, но не
  версию, поэтому ключ доски в файле с правами `0600` (`HEALTH_TOKEN_FILE`)
  обязателен для проверки версии при выкате.
- fleetd (боты на других машинах) требует health-URL
  (`MYR_FLEETD_HEALTH_URL`), достижимый **с хоста выката**, — без него раскат
  отказывает до первого pull. У dockergate health-URL нет намеренно: его
  сокет отвечает только главному процессу доски, а здоровье доказывается его
  журналом.

## Память

Умолчания приёма запусков документируют, сколько свободной памяти ждут на
хосте
([`docs/myrmidon/guides/run-limits.ru.md`](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/run-limits.ru.md)):

- `minFreeHostMemoryMb` по умолчанию `15360` (15 ГБ) — запуск стартует,
  только пока у хоста остаётся не меньше этого объёма `MemAvailable`.
- `runMemoryEstimateMb` по умолчанию `300` МБ — бюджет одного запуска при
  проверке свободной памяти.

Минимальных или рекомендуемых абсолютных размеров CPU/RAM для установки
документация не называет — только указанный порог свободной памяти.

## Диск

- Данные доски живут под корнем данных (по умолчанию `/data` для замера
  диска хоста, `MYRMIDON_HOST_DISK_DATA_ROOT`). Доска меряет заполнение
  диска хоста на каждом тике планировщика и поднимает сигнал внимания на
  пороге (по умолчанию 85 %, critical с 95 %)
  ([`docs/myrmidon/host-disk.ru.md`](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/host-disk.ru.md)).
- Каждый бот владеет каталогом на хосте, где крутятся его контейнеры:
  `<MYRMIDON_BOT_VOLUME_ROOT>/<botKey>/{hermes,workspace,scratch}` — клоны
  рабочих каталогов, дампы scratch, профиль бота. Квоты диска на бота
  настраиваются в настройках экземпляра
  ([`docs/myrmidon/bot-disk-quota.ru.md`](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/bot-disk-quota.ru.md)).
  Раздел под данные ботов рассчитывайте под число ботов и их рабочие копии;
  фиксированной цифры в гигабайтах документы не называют — действующие
  регуляторы это поля квот (`defaultQuotaMb`, `perCaste`, `perAgent`).
- Дампы БД складываются в `DUMP_DIR`; выкат прерывается, если файл дампа
  отсутствует или меньше `DUMP_MIN_BYTES` (1024 в примере).

## Дополнительно для выката (необязательно)

- `MYRMIDON_PREDEPLOY_CHECK=1` (по умолчанию) разворачивает предвыкаточный
  дамп в одноразовый Postgres и поднимает новую доску и новый dockergate на
  копии до окна обслуживания — нужен свободный локальный порт
  (`MYRMIDON_PREDEPLOY_BOARD_PORT`, по умолчанию `13110`) и файл окружения
  доски.
- Загрузочный юнит systemd (`SYSTEMD_UNIT_NAME=paperclip.service`)
  проверяется до любых изменений; `SYSTEMD_UNIT_INSTALL=1` устанавливает
  канонический юнит, если его ещё нет (нужен root).
