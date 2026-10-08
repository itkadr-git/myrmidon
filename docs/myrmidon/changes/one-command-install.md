---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### ONE-COMMAND-INSTALL: one command brings a fresh server to a working board

- `scripts/myrmidon/install/install.sh` (new) installs a fresh server. It checks
  the machine and names what is missing (root, Ubuntu 24.04 / Debian 13, arch, 2
  CPU, 4 GB memory, 10 GB free disk, a free port), installs Docker and the
  compose plugin if absent, resolves the latest release (`releases/latest` or
  `--version myr-vX.Y.Z`) and its manifest `release-components.json`, and pins
  the board, dockergate and bot images BY DIGEST (no flag skips it). It
  generates every secret, writes `deploy.env` (0600), `compose.yml` and the
  dockergate configuration, starts the database, board and dockergate, waits for
  `/api/health` `status: ok` and prints the address, the first-administrator
  link and the written paths.
- Re-running it is the update path: dump the database before the image line
  changes, switch digests, check health, roll back to the previous digests if the
  new board is not healthy. `--uninstall` removes the stack (data kept);
  `--uninstall --purge` also deletes the database volume and install directory.
  It asks nothing by default (`--interactive` enables three questions) and
  speaks Russian or English by locale (`--lang`).
- `scripts/myrmidon/release/publish-github-release.sh` attaches the installer to
  every release as `install.sh`, so
  `https://github.com/itkadr-git/myrmidon/releases/latest/download/install.sh`
  serves the latest one; the committed file is the single source.
- Tests: `scripts/myrmidon/install/install.test.mjs` runs the real script against
  fake `docker`, `curl`, `ss`, `systemctl`, `apt-get`: digest pinning and secrets,
  update with a dump, rollback on an unhealthy release, no-op on the same
  release, foreign directory refused, uninstall/purge, Russian locale, malformed
  `--version` refused.

## changelog-ru

### ONE-COMMAND-INSTALL: одна команда приводит чистый сервер к работающей доске

- `scripts/myrmidon/install/install.sh` (новый) — установщик чистой установки.
  Проверяет машину по системным требованиям и человеческим языком говорит, чего
  не хватает (root, Ubuntu 24.04 / Debian 13, архитектура, 2 ядра, 4 ГБ памяти,
  10 ГБ свободного диска, свободный порт), ставит Docker и плагин compose, если
  их нет, находит последний выпуск (`releases/latest` или `--version myr-vX.Y.Z`)
  и его машиночитаемый манифест `release-components.json`, и закрепляет образы
  доски, dockergate и ботов ДАЙДЖЕСТОМ — то же правило «только образы CI», что и
  у скриптов выката, без флага обхода. Создаёт все секреты (пароль базы, секрет
  сессий, секрет подписи действий инструментов), пишет `deploy.env` (режим 0600),
  `compose.yml` и конфигурацию dockergate, поднимает базу, доску и dockergate,
  ждёт `/api/health` со `status: ok` и печатает адрес, ссылку на создание первого
  администратора и пути записанных файлов.
- Повторный запуск установщика — это обновление: он находит последний выпуск,
  снимает дамп базы до смены строки образа, переключает дайджесты, проверяет
  здоровье и возвращает дайджесты, которые работали раньше, если новая доска не
  стала здоровой. `--uninstall` останавливает и снимает стек (данные остаются);
  `--uninstall --purge` удаляет и том с базой, и каталог установки. По умолчанию
  скрипт ничего не спрашивает (`--interactive` включает три вопроса) и говорит
  по-русски или по-английски по локали (`--lang`).
- `scripts/myrmidon/release/publish-github-release.sh` — каждый выпуск теперь
  несёт установщик вложением `install.sh`, поэтому
  `https://github.com/itkadr-git/myrmidon/releases/latest/download/install.sh`
  всегда отдаёт установщик последнего выпуска. Истина — файл в репозитории.
- Тесты: `scripts/myrmidon/install/install.test.mjs` (новый) запускает настоящий
  скрипт против подставных `docker`, `curl`, `ss`, `systemctl` и `apt-get`,
  поставленных первыми в `PATH`: чистая установка закрепляет дайджесты и
  создаёт секреты, повтор против нового выпуска снимает дамп базы и переключает
  дайджесты, нездоровая новая доска откатывается на прежние дайджесты, уже
  работающий выпуск ничего не меняет, чужой каталог отклоняется, `--uninstall`
  сохраняет данные, `--purge` их удаляет, русская локаль соблюдается, а
  искажённый `--version` отклоняется. Ни один тест не ходит в GitHub, реестр или
  docker-демон.

## divergence

| ONE-COMMAND-INSTALL | Установщик чистой установки: `install.sh` одной командой ставит Docker и плагин compose, закрепляет образы выпуска дайджестом из манифеста `release-components.json`, генерирует секреты, пишет `deploy.env`/`compose.yml`/конфигурацию dockergate, поднимает базу, доску и dockergate, ждёт `/api/health` `status: ok`, печатает адрес и ссылку на создание первого администратора. Повтор = обновление с дампом базы, проверкой здоровья и откатом на прежние дайджесты; `--uninstall [--purge]`; без вопросов по умолчанию (`--interactive`); русский и английский по локали | Вендорские файлы не тронуты; + `scripts/myrmidon/install/install.sh`, + `scripts/myrmidon/install/install.test.mjs`, + `scripts/myrmidon/release/publish-github-release.sh` (вложение `install.sh` в выпуск) | Владелец (06.10): у Myrmidon не было своего установщика — `scripts/install.sh` ставит Paperclip вендора (npm `paperclipai`), а развёртывание (`deploy.sh`, deploy.env) требует ручной подготовки. Нужна одна команда, понятная неопытному человеку | `scripts/myrmidon/install/install.test.mjs` | Никогда, наше поведение. Удалить каталог `scripts/myrmidon/install` и блок вложения установщика в `publish-github-release.sh` | (этот PR) |
