# Семейство образов среды агента

Контейнерные образы для запуска harness-клиентов кодирующих агентов в изолированной среде. Имена образов имеют вид `agent-runtime-{harness}:{version}`. В этой директории описаны bake-цели и автоматизированная публикация; наличие CI lane само по себе не подтверждает, что тег уже опубликован. Для OMP используется отдельный образ `ghcr.io/paperclipai/agent-runtime-omp`, не основанный на базовом образе и не запускающий `paperclip-agent-shim`.

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

Цель `omp` объявлена в `docker/agent-runtime/buildx-bake.hcl` для `linux/amd64`. Переменные bake по умолчанию: `REGISTRY=ghcr.io/paperclipai`, `VERSION=dev`.

Локальная проверка сборочного графа/образа (не публикация):

```sh
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl omp --load
docker run --rm --user 1000:1000 \
  --mount type=bind,src=<session-dir>,dst=/home/paperclip/.local/share/omp/sessions \
  --mount type=bind,src=<workspace-dir>,dst=/workspace \
  ghcr.io/paperclipai/agent-runtime-omp:dev --help
```

Замените `<session-dir>` и `<workspace-dir>` реальными каталогами хоста; образу нужен доступ на запись к ним. Для проверки уже опубликованного образа используйте подтверждённый тег или digest из CI, а не предполагайте, что `dev` существует:

```sh
docker run --rm --user 1000:1000 \
  --mount type=bind,src=<session-dir>,dst=/home/paperclip/.local/share/omp/sessions \
  --mount type=bind,src=<workspace-dir>,dst=/workspace \
  ghcr.io/paperclipai/agent-runtime-omp:<verified-tag-or-digest> --help
```

## Публикация и подпись

Workflow `.github/workflows/agent-runtime-images.yml` запускается при push в `master` с затрагивающими его путями изменениями либо вручную через `workflow_dispatch`. При ручном запуске задаётся версия; иначе тег строится как `git-<commit-sha>`. В bake-публикацию явно входят `base`, `opencode`, `pi`, `codex`, `gemini`, `claude` и `omp` (`linux/amd64`; `hermes` не включён в scope). Workflow получает дайджесты опубликованных образов и подписывает их через cosign keyless OIDC с GitHub Actions identity.

Для этого изменения пока не проверены успешный запуск workflow и опубликованные OMP-тег/digest. Перед использованием образа проверьте успешный запуск workflow, фактический digest в GHCR и подпись.
