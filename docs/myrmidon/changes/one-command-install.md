---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### ONE-COMMAND-INSTALL: one command brings a fresh server to a working board

- `scripts/myrmidon/install/install.sh` (new) — the installer of a fresh
  installation. It checks the machine against the system requirements and names
  what is missing in plain language (root, Ubuntu 24.04 / Debian 13, arch, 2 CPU,
  4 GB memory, 10 GB free disk, a free port), installs Docker and the compose
  plugin when they are absent, resolves the latest release
  (`releases/latest` or `--version myr-vX.Y.Z`) and its machine-readable
  manifest `release-components.json`, and pins the board, dockergate and bot
  images BY DIGEST — the CI-only rule the deploy scripts enforce, with no flag
  that skips it. It generates every secret (database password, session secret,
  tool-action signing secret), writes `deploy.env` (mode 0600), `compose.yml`
  and the dockergate configuration, brings up the database, the board and
  dockergate, waits for `/api/health` `status: ok` and prints the address, the
  first-administrator link and the paths of the files it wrote.
- Re-running the installer is the update path: it resolves the latest release,
  dumps the database before the image line changes, switches the digests, checks
  health and rolls back to the digests that ran before when the new board does
  not become healthy. `--uninstall` stops and removes the stack (data kept);
  `--uninstall --purge` also deletes the database volume and the install
  directory. The installer asks nothing by default (`--interactive` turns the
  three questions on) and speaks Russian or English according to the locale
  (`--lang`).
- `scripts/myrmidon/release/publish-github-release.sh` — every release now
  carries the installer as the asset `install.sh`, so
  `https://github.com/itkadr-git/myrmidon/releases/latest/download/install.sh`
  always serves the installer of the latest release. The committed file is the
  single source of truth.
- Tests: `scripts/myrmidon/install/install.test.mjs` (new) runs the real script
  against fake `docker`, `curl`, `ss`, `systemctl` and `apt-get` placed first in
  `PATH`: a fresh install pins the digests and generates the secrets, a re-run
  against a newer release dumps the database and switches the digests, an
  unhealthy new release rolls back to the previous digests, a release that
  already runs changes nothing, a foreign directory is refused, `--uninstall`
  keeps the data and `--purge` removes it, the Russian locale is honoured and a
  malformed `--version` is refused. No test touches GitHub, a registry or a
  docker daemon.

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
