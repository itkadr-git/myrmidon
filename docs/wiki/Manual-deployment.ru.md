# Ручной выкат (deploy.sh)

> English version: [Manual-deployment](Manual-deployment)

Ручной выкат — поток с окном обслуживания, на нём работает боевой сервер
проекта. **Для установки с нуля эта страница не нужна**: [Установка](Installation.ru)
делает всё одной командой. Материал ниже — для администраторов, которые ведут
выкат руками. Всё здесь взято из
[`docs/myrmidon/deploy.ru.md`](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/deploy.ru.md) —
основной версии документации.

## 1. Подготовьте хост

Сначала сверьтесь с [Системными требованиями](System-requirements.ru).
Коротко:

1. Установите bash 4+, Docker с плагинами `compose` и `buildx`, `curl`,
   `jq`, `git`.
2. Склонируйте этот репозиторий на хост выката; его `origin` должен смотреть
   на `github.com/itkadr-git/myrmidon` — скрипт выката сверяет коммит образа
   по этому клону и в любом другом случае отказывается работать.
3. Сервер Myrmidon должен работать под управлением docker compose, а образ
   сервиса задаётся в отдельном override-файле (`COMPOSE_OVERRIDE_FILE`):
   скрипт переписывает в нём только строку `image:`.
4. Подготовьте команду дампа БД (`DUMP_COMMAND`) и, для отката с
   восстановлением, команду восстановления (`RESTORE_COMMAND`).

## 2. Заполните файл настроек

Скопируйте
[`scripts/myrmidon/deploy/deploy.env.example`](https://github.com/itkadr-git/myrmidon/blob/main/scripts/myrmidon/deploy/deploy.env.example)
в приватный репозиторий развёртывания (и никогда — в этот) и подставьте
настоящие значения: пути compose-проекта, `HEALTH_URL`, `STATE_DIR`,
`DUMP_DIR`, режим обслуживания, компоненты релиза
(`MYRMIDON_RELEASE_COMPONENTS`, по умолчанию `dockergate,fleetd`), а для
первой установки — `SYSTEMD_UNIT_INSTALL=1`, чтобы установился штатный юнит
автозапуска.

В режиме `authenticated` задайте в `HEALTH_TOKEN_FILE` путь к файлу с ключом
доски и правами `0600`: без него проверка версии не проходит, и выкат
считается неудачным — так и задумано.

## 3. Возьмите digest образа

Выкат фиксирует **digest** образа, а не тег. Источники:

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

Для опубликованного выпуска короткая форма сама находит digest всех
компонентов в манифесте релиза:

```sh
scripts/myrmidon/deploy/deploy.sh --config /path/to/deploy.env --release myr-vX.Y.Z
```

До любых изменений скрипт проверяет, что образ собран CI из `main` или тега
`myr-v*`, разворачивает предвыкаточный дамп в одноразовый Postgres и
убеждается на нём, что новая доска работает. Затем открывается одно окно
обслуживания: доска и компоненты релиза катятся вместе, после чего
проверяется здоровье. Сбой любого компонента внутри окна откатывает всё
изменённое вместе (`MYRMIDON_COMPONENT_AUTO_ROLLBACK=1`, по умолчанию).

## 5. Проверьте, что доска поднялась

```sh
curl http://127.0.0.1:3100/api/health
```

Ответ должен показать `status: ok` и версию (`myr-v…`) — в режиме
`authenticated` передавайте ключ доски. Затем откройте доску в браузере и
завершите настройку в интерфейсе: модели и агенты живут в своих карточках,
матрица автономии и список участников — в настройках компании. Там же
создаётся первый агент и получает модель и ключи: из карточки агента доска
создаёт его изолированный контейнер и дальше следит за ним (см.
[Настройки в интерфейсе](Settings-in-the-interface.ru)).

## 6. После выката

- Обновление и откат идут тем же скриптом — см.
  [Обновление и откат](Upgrading-and-rollback.ru).
- Переключатели инстанса (`MYRMIDON_*`) описаны в
  [SETTINGS.ru.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/SETTINGS.ru.md).
