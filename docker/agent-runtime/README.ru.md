# Семейство образов среды агента

Контейнерные образы для запуска harness-клиентов кодирующих агентов в изолированной среде. Имена образов имеют вид `agent-runtime-{harness}:{version}`. В этой директории описаны bake-цели и автоматизированная публикация; наличие CI lane само по себе не подтверждает, что тег уже опубликован. Для OMP используется отдельный образ `ghcr.io/itkadr-git/agent-runtime-omp`, не основанный на базовом образе и не запускающий `paperclip-agent-shim`.

## Набор образов

- **`agent-runtime-base`**: основа на Ubuntu 22.04 с Node 24, git, tini, пользователем без root (uid/gid 1000) и shim агента.
- **`agent-runtime-opencode`**: расширяет base, глобально устанавливая `opencode-ai`.
- **`agent-runtime-pi`**: расширяет base с `@mariozechner/pi-coding-agent`.
- **`agent-runtime-codex`**: расширяет base с `@openai/codex`.
- **`agent-runtime-gemini`**: расширяет base с `@google/gemini-cli` и настройками headless-режима.
- **`agent-runtime-claude`**: расширяет base с `@anthropic-ai/claude-code` (ссылка `claude-code`).
- **`agent-runtime-hermes`**: цель bake; не входит в список целей публикации workflow.
- **`agent-runtime-omp`**: самостоятельная среда OMP на Bun 1.4.3 с закреплённым `@oh-my-pi/pi-coding-agent` 18.9.2.

## Образ OMP

`docker/agent-runtime/Dockerfile.omp` использует `oven/bun:1.4.3-alpine` напрямую. Он не наследует Node/shim-образ и запускает OMP как команду контейнера (`CMD ["omp"]`). Внутри создан пользователь `paperclip` с uid/gid `1000:1000`; `HOME`, каталоги XDG и каталог сессий OMP находятся в `/home/paperclip`. `/workspace` — рабочая директория и точка монтирования рабочей области. При запуске снаружи обеспечьте запись в смонтированные каталоги от uid/gid 1000.

Сборка выполняет smoke-check без вызова модели или провайдера: точные версии Bun (`1.4.3`) и OMP (`18.9.2`), наличие `omp` в `PATH`, `omp --help` и `omp models ls`.

## Сборка и проверка

Цель `omp` объявлена в `docker/agent-runtime/buildx-bake.hcl` для `linux/amd64`. Переменные bake по умолчанию: `REGISTRY=ghcr.io/itkadr-git`, `VERSION=dev`.

Локальная проверка сборочного графа/образа (не публикация):

```sh
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl omp --load
docker run --rm --user 1000:1000 \
  --mount type=bind,src=<session-dir>,dst=/home/paperclip/.local/share/omp/sessions \
  --mount type=bind,src=<workspace-dir>,dst=/workspace \
  ghcr.io/itkadr-git/agent-runtime-omp:dev --help
```

Замените `<session-dir>` и `<workspace-dir>` реальными каталогами хоста; образу нужен доступ на запись к ним. Для проверки уже опубликованного образа используйте подтверждённый тег или digest из CI, а не предполагайте, что `dev` существует:

```sh
docker run --rm --user 1000:1000 \
  --mount type=bind,src=<session-dir>,dst=/home/paperclip/.local/share/omp/sessions \
  --mount type=bind,src=<workspace-dir>,dst=/workspace \
  ghcr.io/itkadr-git/agent-runtime-omp:<verified-tag-or-digest> --help
```

## Исполнитель omp по SSH

`docker/agent-runtime/Dockerfile.omp-ssh` (цель bake `omp-ssh`, образ
`agent-runtime-omp-ssh`) — среда выполнения для агентов `omp_local`. Агент
привязан к **SSH-окружению** доски, которое указывает на контейнер из этого
образа. CLI omp, его вызовы инструментов и запущенные ими сборки работают в этом
контейнере, со своими лимитами памяти, CPU и числа процессов. Контейнер доски
только синхронизирует по SSH рабочую копию и ресурсы прогона и передаёт вывод.

Поверх `agent-runtime-base` образ добавляет:
- Bun и omp, закреплённые так же, как в образе доски;
- pnpm из `packageManager` репозитория;
- GitHub CLI и набор сборки C;
- `openssh-server`.

sshd слушает порт 2222 и пускает только по ключу, только пользователя
`paperclip`. Открытый ключ доски монтируется только для чтения в
`/etc/ssh/omp-runner/authorized_keys`. Ключ хоста создаётся при первом запуске в
том `hostkeys` и сохраняется при пересоздании.

Один исполнитель на агента:

1. Создать пару ключей для исполнителя. Закрытый ключ не должен попасть в журналы
   и историю оболочки.
2. Запустить контейнер по `docker/agent-runtime/omp-ssh/compose.yml`. В файле
   переменных задать:
   - `OMP_RUNNER_NAME`;
   - `OMP_RUNNER_IMAGE` — дайджест из успешного подписанного прогона;
   - `OMP_RUNNER_AUTHORIZED_KEYS` — файл открытого ключа;
   - `OMP_RUNNER_NETWORK` — сеть контейнера доски.

   Лимиты по умолчанию: 8 ГБ, 4 CPU, 4096 процессов. Команда:
   `docker compose -p <имя> --env-file <файл> -f docker/agent-runtime/omp-ssh/compose.yml up -d`.
3. Взять ключ хоста из строки журнала контейнера `omp-runner: generated host key`
   или командой `ssh-keyscan -p 2222 <имя>` из сети доски.
4. На доске создать окружение с драйвером `ssh`:
   - хост `<имя>`, порт `2222`, пользователь `paperclip`;
   - удалённый путь рабочей копии `/workspace`;
   - закрытый ключ (доска хранит его как секрет компании);
   - known hosts `[<имя>]:2222 <ключ хоста>`, строгая проверка ключа хоста включена.

   Выполнить проверку окружения.
5. Назначить это окружение агенту окружением по умолчанию.

Проверка после первого прогона:
- во время прогона `docker top <контейнер доски>` не показывает процесс `omp`, а `docker top <имя>` показывает;
- журнал прогона называет SSH-окружение в строке `Syncing workspace and OMP runtime assets to`.

## Публикация и подпись

Workflow `.github/workflows/agent-runtime-images.yml` запускается при push в `main` и релизных тегах `myr-v*` с затрагивающими его путями изменениями либо вручную через `workflow_dispatch`. При ручном запуске задаётся версия; иначе тег строится как `git-<commit-sha>`. В bake-публикацию явно входят `base`, `opencode`, `pi`, `codex`, `gemini`, `claude`, `omp` и `omp-ssh` (`linux/amd64`; `hermes` не включён в scope). Workflow получает дайджесты опубликованных образов и подписывает их через cosign keyless OIDC с GitHub Actions identity.

Для этого изменения пока не проверены успешный запуск workflow и опубликованные OMP-тег/digest. Перед использованием образа проверьте успешный запуск workflow, фактический digest в GHCR и подпись.
