# Быстрый старт

> English version: [Quick-start](Quick-start)

Краткий путь, сжатый из [Установки](Installation.ru) — перед настоящей
установкой прочитайте полную страницу.

1. Подготовьте хост: bash 4+, Docker с плагинами `compose` и `buildx`,
   `curl`, `jq`, `git` и клон этого репозитория (см.
   [Системные требования](System-requirements.ru)).
2. Скопируйте
   [`scripts/myrmidon/deploy/deploy.env.example`](https://github.com/itkadr-git/myrmidon/blob/main/scripts/myrmidon/deploy/deploy.env.example)
   в приватный репозиторий развёртывания и заполните.
3. Возьмите digest релиза из workflow Actions **Myrmidon image** (или
   `docker buildx imagetools inspect`), затем:

   ```sh
   scripts/myrmidon/deploy/deploy.sh --config /path/to/deploy.env --digest sha256:<digest> --dry-run
   scripts/myrmidon/deploy/deploy.sh --config /path/to/deploy.env --digest sha256:<digest>
   ```

4. Проверьте доску: `curl http://127.0.0.1:3100/api/health` показывает
   версию (`myr-v…`). Откройте доску в браузере и завершите настройку
   (модели, агенты, каналы) в интерфейсе.

Дальше: [Обновление и откат](Upgrading-and-rollback.ru),
[Настройки в интерфейсе](Settings-in-the-interface.ru).
