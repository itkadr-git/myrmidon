# Ручной выкат (deploy.sh)

> English version: [Manual-deployment](Manual-deployment)

Поток ручного выката с окном обслуживания — под ним работает боевой сервер.
**Для установки с нуля эта страница не нужна**: используйте
[Установку](Installation.ru) — одна команда делает всё сама. Эта страница —
для администраторов, которые ведут выкат руками. Всё здесь находится в
[`docs/myrmidon/deploy.ru.md`](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/deploy.ru.md) —
основной версии документации.

## 1. Подготовьте хост

Сначала сверьтесь с [Системными требованиями](System-requirements.ru).
Коротко:

1. Установите bash 4+, Docker с плагинами `compose` и `buildx`, `curl`,
   `jq`, `git`.
2. Склонируйте этот репозиторий на хост выката; его `origin` должен смотреть
   на `github.com/itkadr-git/myrmidon` — скрипт выката сверяет коммит образа
   по этому клону и из любого другого места отказывает.
3. Сервер Myrmidon должен управляться docker compose, а образ сервиса —
   задаваться в отдельном override-файле (`COMPOSE_OVERRIDE_FILE`): скрипт
   переписывает в нём только строку `image:`.
4. Подготовьте команду дампа БД (`DUMP_COMMAND`) и, для отката с
   восстановлением, команду восстановления (`RESTORE_COMMAND`).

## 2. Заполните файл настроек

Скопируйте
[`scripts/myrmidon/deploy/deploy.env.example`](https://github.com/itkadr-git/myrmidon/blob/main/scripts/myrmidon/deploy/deploy.env.example)
в приватный репозиторий развёртывания (никогда в этот) и заполните
реальные значения: пути compose-проекта, `HEALTH_URL`, `STATE_DIR`,
`DUMP_DIR`, режим обслуживания, компоненты релиза
(`MYRMIDON_RELEASE_COMPONENTS`, по умолчанию `dockergate,fleetd`), а для
первой установки — `SYSTEMD_UNIT_INSTALL=1`, чтобы установился канонический
загрузочный юнит.

В режиме `authenticated` укажите `HEALTH_TOKEN_FILE` на файл с правами
`0600` с ключом доски: без него проверка версии не проходит и выкат
считается неудачным — так задумано.

## 3. Возьмите digest образа

Выкат фиксирует **digest** образа, никогда тег. Источники:

- сводка job `image` workflow **Myrmidon image** (Actions → запуск на коммите
  или теге выпуска), строка `Digest`; или
- реестр:

```sh
docker buildx imagetools inspect ghcr.io/itkadr-git/myrmidon:<версия> --format '{{json .Manifest.Digest}}'
```

## 4. Выкат

Сначала сухой прогон, затем настоящий:

```sh
scripts/myrmidon/deploy/deploy.sh --config /path/to/deploy.env --digest sha256:<digest> --dry-run
scripts/myrmidon/deploy/deploy.sh --config /path/to/deploy.env --digest sha256:<digest>
```

Для опубликованного выпуска короткая форма сама резолвит digest всех
компонентов из манифеста релиза:

```sh
scripts/myrmidon/deploy/deploy.sh --config /path/to/deploy.env --release myr-vX.Y.Z
```

Скрипт до любых изменений проверяет, что образ собран CI из `main` или тега
`myr-v*`, разворачивает предвыкаточный дамп в одноразовый Postgres и
доказывает на нём новую доску, открывает одно окно обслуживания, катит доску
и компоненты релиза вместе и проверяет здоровье. Сбой любого компонента
внутри окна откатывает всё изменённое вместе
(`MYRMIDON_COMPONENT_AUTO_ROLLBACK=1`, по умолчанию).

## 5. Проверьте, что доска поднялась

```sh
curl http://127.0.0.1:3100/api/health
```

Ответ должен показать `status: ok` и версию (`myr-v…`) — в режиме
`authenticated` передавайте ключ доски. Затем откройте доску в браузере и
завершите настройку в интерфейсе: модели и агенты — в их карточках, матрица
автономии и список участников — в настройках компании. Там же создаётся
первый агент и получает свою модель и ключи — из его карточки доска создаёт
и обслуживает его изолированный контейнер (см.
[Настройки в интерфейсе](Settings-in-the-interface.ru)).

## 6. Второй день

- Обновление и откат идут тем же скриптом — см.
  [Обновление и откат](Upgrading-and-rollback.ru).
- Переключатели инстанса (`MYRMIDON_*`) описаны в
  [SETTINGS.ru.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/SETTINGS.ru.md).
