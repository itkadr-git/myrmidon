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

`docker/agent-runtime/Dockerfile.omp` использует `oven/bun:1.4.3-slim` напрямую (alpine не подходит: `pi-natives` поставляется только с бинарниками под glibc и падает на musl с ошибкой `Cannot find module pi_natives.linux-x64*.node`, OPE-7762). Он не наследует Node/shim-образ и запускает OMP как команду контейнера (`CMD ["omp"]`). Процесс запускается с uid/gid `1000:1000` (`USER 1000:1000`); `HOME=/home/paperclip` задан через `ENV`; каталоги `/home/paperclip` и `/workspace` принадлежат `1000:1000`. `HOME`, каталоги XDG и каталог сессий OMP находятся в `/home/paperclip`. `/workspace` — рабочая директория и точка монтирования рабочей области. При запуске снаружи обеспечьте запись в смонтированные каталоги от uid/gid 1000.

Сборка выполняет smoke-check без вызова модели или провайдера: точные версии Bun (`1.4.3`) и OMP (`18.9.2`), наличие `omp` в `PATH`, `omp --help` и `omp models ls`.

## Соответствие SANDBOX-REQUIREMENTS

Сопоставление образов `agent-runtime-*` с требованиями `packages/plugins/sandbox-providers/SANDBOX-REQUIREMENTS.md` на основе инструкций Dockerfile:

| Требование | `base` | `claude` | `codex` | `gemini` | `opencode` | `pi` | `omp` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `node` в PATH | Обеспечено Dockerfile (`RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x \| bash - && apt-get install -y --no-install-recommends nodejs`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-claude:<тег> -c 'command -v node sh tar'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-codex:<тег> -c 'command -v node sh tar'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-gemini:<тег> -c 'command -v node sh tar'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-opencode:<тег> -c 'command -v node sh tar'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-pi:<тег> -c 'command -v node sh tar'`) | Берётся из базового образа `oven/bun:1.4.3-slim` — не проверено сборкой (`node` не устанавливается в `Dockerfile.omp`; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-omp:<тег> -c 'command -v node sh tar'`) |
| Нужный CLI в PATH (под каким именем) | Не обеспечено (образ содержит только `/usr/local/bin/paperclip-agent-shim` через `COPY --from=shim-build /out/paperclip-agent-shim /usr/local/bin/paperclip-agent-shim`, CLI агентов не устанавливаются) | Обеспечено Dockerfile (`RUN npm install -g @anthropic-ai/claude-code@latest ...`, `RUN CLAUDE_BIN="$(command -v claude)" && ln -s "$CLAUDE_BIN" /usr/bin/claude-code`, `RUN command -v claude-code >/dev/null 2>&1 \|\| ...`; имя: `claude-code`) | Обеспечено Dockerfile (`RUN npm install -g @openai/codex@latest ...`, `RUN command -v codex >/dev/null 2>&1 \|\| ...`; имя: `codex`) | Обеспечено Dockerfile (`RUN npm install -g @google/gemini-cli@latest ...`, `RUN command -v gemini >/dev/null 2>&1 \|\| ...`; имя: `gemini`) | Обеспечено Dockerfile (`RUN npm install -g opencode-ai@latest ...`, `RUN command -v opencode >/dev/null 2>&1 \|\| ...`; имя: `opencode`) | Обеспечено Dockerfile (`RUN npm install -g @mariozechner/pi-coding-agent@latest ...`, `RUN command -v pi >/dev/null 2>&1 \|\| ...`; имя: `pi`) | Обеспечено Dockerfile (`RUN ... bun add --global "@oh-my-pi/pi-coding-agent@${OMP_VERSION}" ... && ln -sf "$BUN_GLOBAL_BIN/omp" /usr/local/bin/omp ...`, `RUN ... command -v omp ...`; имя: `omp`) |
| `sh` | Берётся из базового образа `ubuntu:22.04` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-base:<тег> -c 'command -v node sh tar'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-claude:<тег> -c 'command -v node sh tar'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-codex:<тег> -c 'command -v node sh tar'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-gemini:<тег> -c 'command -v node sh tar'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-opencode:<тег> -c 'command -v node sh tar'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-pi:<тег> -c 'command -v node sh tar'`) | Берётся из базового образа `oven/bun:1.4.3-slim` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-omp:<тег> -c 'command -v node sh tar'`) |
| `tar` | Берётся из базового образа `ubuntu:22.04` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-base:<тег> -c 'command -v node sh tar'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-claude:<тег> -c 'command -v node sh tar'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-codex:<тег> -c 'command -v node sh tar'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-gemini:<тег> -c 'command -v node sh tar'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-opencode:<тег> -c 'command -v node sh tar'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-pi:<тег> -c 'command -v node sh tar'`) | Берётся из базового образа `oven/bun:1.4.3-slim` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-omp:<тег> -c 'command -v node sh tar'`) |
| Записываемые workspace, HOME, каталог кэша, каталог tmp | Обеспечено Dockerfile для `HOME` и `~/.cache` (`RUN ... groupadd -g 1000 paperclip && useradd -u 1000 -g 1000 -d /home/paperclip -m -s /bin/bash paperclip`, `USER 1000:1000`); `WORKDIR /workspace` (без `chown`) и `/tmp` берутся из базового образа `ubuntu:22.04` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-base:<тег> -c 'test -w /workspace && test -w "$HOME" && mkdir -p "$HOME/.cache" && test -w "$HOME/.cache" && test -w /tmp'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`USER 1000:1000`; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-claude:<тег> -c 'test -w /workspace && test -w "$HOME" && mkdir -p "$HOME/.cache" && test -w "$HOME/.cache" && test -w /tmp'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`USER 1000:1000`; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-codex:<тег> -c 'test -w /workspace && test -w "$HOME" && mkdir -p "$HOME/.cache" && test -w "$HOME/.cache" && test -w /tmp'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`USER 1000:1000`, дополнительно `RUN mkdir -p /home/paperclip/.gemini`; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-gemini:<тег> -c 'test -w /workspace && test -w "$HOME" && mkdir -p "$HOME/.cache" && test -w "$HOME/.cache" && test -w /tmp'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`USER 1000:1000`; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-opencode:<тег> -c 'test -w /workspace && test -w "$HOME" && mkdir -p "$HOME/.cache" && test -w "$HOME/.cache" && test -w /tmp'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (`USER 1000:1000`; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-pi:<тег> -c 'test -w /workspace && test -w "$HOME" && mkdir -p "$HOME/.cache" && test -w "$HOME/.cache" && test -w /tmp'`) | Обеспечено Dockerfile для workspace, HOME и каталога кэша (`ENV HOME=/home/paperclip`, `ENV XDG_CACHE_HOME=/home/paperclip/.cache`, `RUN mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$OMP_SESSION_DIR" /workspace && chown -R 1000:1000 /home/paperclip /workspace`, `WORKDIR /workspace`, `USER 1000:1000`); `/tmp` берётся из базового образа `oven/bun:1.4.3-slim` — не проверено сборкой (`docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-omp:<тег> -c 'test -w /tmp'`) |
| Профили входа не изменяются | Обеспечено Dockerfile (в `Dockerfile.base` отсутствуют инструкции изменения `/etc/profile` или rc-файлов; `ENTRYPOINT ["/usr/bin/tini", "--"]`, `CMD ["/usr/local/bin/paperclip-agent-shim"]`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (инструкции изменения профилей в `Dockerfile.claude` отсутствуют; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-claude:<тег> -c 'ls -la /etc/profile "$HOME"/.profile "$HOME"/.bashrc 2>/dev/null \|\| true'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (инструкции изменения профилей в `Dockerfile.codex` отсутствуют; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-codex:<тег> -c 'ls -la /etc/profile "$HOME"/.profile "$HOME"/.bashrc 2>/dev/null \|\| true'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (инструкции изменения профилей в `Dockerfile.gemini` отсутствуют; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-gemini:<тег> -c 'ls -la /etc/profile "$HOME"/.profile "$HOME"/.bashrc 2>/dev/null \|\| true'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (инструкции изменения профилей в `Dockerfile.opencode` отсутствуют; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-opencode:<тег> -c 'ls -la /etc/profile "$HOME"/.profile "$HOME"/.bashrc 2>/dev/null \|\| true'`) | Берётся из базового образа `paperclipai/agent-runtime-base` — не проверено сборкой (инструкции изменения профилей в `Dockerfile.pi` отсутствуют; `docker run --rm --entrypoint sh ghcr.io/itkadr-git/agent-runtime-pi:<тег> -c 'ls -la /etc/profile "$HOME"/.profile "$HOME"/.bashrc 2>/dev/null \|\| true'`) | Обеспечено Dockerfile (в `Dockerfile.omp` отсутствуют инструкции изменения `/etc/profile` или rc-файлов; `CMD ["omp"]`) |

Каждая клетка с отметкой «Берётся из базового образа `<имя>` — не проверено сборкой» содержит команду проверки для соответствующего образа (`<тег>` — `dev` для локальной сборки bake или подтверждённый тег/digest из CI).

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

### Общий кеш пакетов (OPE-12722)

Исполнитель пользуется общим кешем пакетов доски так же, как контейнеры ботов.
Задайте в файле переменных `OMP_RUNNER_CACHE_DIR` (необязательно) — каталог на
диске данных ботов, например `/srv/myrmidon-cache` (это
`general.botDisk.sharedPackageCachePath` доски). Без неё compose берёт
`${OMP_RUNNER_DATA_DIR}/cache` — кеш самого исполнителя без зеркал доски (враппер
git тогда просто ничего не делает). Compose привязывает в контейнер два
подкаталога. Создайте оба **до первого запуска**: отсутствующий источник привязки
docker создаёт от root.

- `<OMP_RUNNER_CACHE_DIR>/git` → `/cache/git` (только чтение). Там лежат
  git-зеркала доски (`git/<owner>/<repo>.git`); доска сама их пишет и
  обновляет, поэтому каталог должен принадлежать **пользователю доски** и быть
  доступным на чтение всем:
  `install -d -o <uid доски> -m 0755 <OMP_RUNNER_CACHE_DIR>/git`. Если его
  создаст docker от root, доска не сможет писать туда зеркала. Образ ставит
  небольшой враппер в `/usr/local/bin/git`, который PATH находит раньше
  `/usr/bin/git`: обычный
  `git clone https://github.com/<owner>/<repo>.git` выполняется как
  `git clone --reference-if-able /cache/git/<owner>/<repo>.git …`, и клон берёт
  готовые объекты из зеркала вместо повторной полной загрузки. Враппер только
  читает: зеркала он не создаёт и не обновляет, а любой клон без зеркала
  (другой хост, опция, решающая способ хранения, — `--dissociate`, `--filter`)
  выполняется без изменений. Из-за враппера клон не может сломаться.
- `<OMP_RUNNER_CACHE_DIR>/pnpm-omp` → `/cache/pnpm` (чтение и запись).
  **Собственный** каталог исполнителей, владелец — uid 1000:
  `install -d -o 1000 -g 1000 -m 0755 <OMP_RUNNER_CACHE_DIR>/pnpm-omp`. Это
  намеренно не `<OMP_RUNNER_CACHE_DIR>/pnpm`: его монтируют боты hermes
  (uid 10001), и их подготовительный шаг возвращает ему владельца 10001, так что
  исполнитель, сделав chown, перебивал бы владельца туда-сюда и ломал одну из
  сторон. Entrypoint пишет `/etc/profile.d/omp-runner-cache.sh` со строками
  `npm_config_cache_dir=/cache/pnpm` (кеш метаданных pnpm) и
  `npm_config_cache=/cache/pnpm` (кеш загрузок npm — тарболы и `_cacache`;
  pnpm и npm читают разные имена — pnpm `cache-dir`, npm `cache`, — поэтому
  общий каталог экспортируется под обоими именами, и загрузки обоих
  инструментов попадают на общее монтирование вместо раздельного `~/.npm` у
  каждого исполнителя), когда монтирование принадлежит uid 1000 (sshd не
  передаёт переменные окружения контейнера в сессии, а profile.d читает каждая
  команда, запущенная доской по SSH, и каждая оболочка агента). Он исправляет
  владельца только у каталога от root (его создал docker) и никогда не делает
  chown каталога другого uid: пишет предупреждение и оставляет кеши по
  умолчанию.
- `<OMP_RUNNER_CACHE_DIR>/pnpm-store-omp` → `/cache/pnpm-store` (чтение и
  запись). **Общее хранилище pnpm** для всех исполнителей (OPE-13018),
  владелец — uid 1000:
  `install -d -o 1000 -g 1000 -m 0755 <OMP_RUNNER_CACHE_DIR>/pnpm-store-omp`.
  Одно хранилище на хост вместо копии по 2,5 ГБ на исполнителя; оно должно
  лежать на той же файловой системе XFS, что и тома исполнителей, чтобы
  работал рефлинк.

Хранилище pnpm (**store**, OPE-13018). Entrypoint пишет
`/etc/profile.d/omp-runner-pnpm.sh` со строкой
`npm_config_store_dir=/cache/pnpm-store`, когда compose-файл монтирует общее
хранилище, и возвращается к старому хранилищу исполнителя
`/workspace/.paperclip-runtime/pnpm-store`, когда монтирования нет (исполнитель
с compose до OPE-13018). Общее хранилище работает потому, что лежит на той же
файловой системе XFS, что и тома исполнителей: pnpm делает рефлинк
`node_modules` через bind-монтирования, не копируя пакеты. Хранилище на другой
файловой системе заставило бы pnpm копировать каждый пакет в каждый клон
(BOT-DISK-D в образе bot-runtime). Старое хранилище внутри workspace лежит во
`.paperclip-runtime` потому, что доска чистит синхронизируемую рабочую папку по
своим правилам (`git clean -fdx -e .paperclip-runtime`, очистка каталога кроме
`.paperclip-runtime`, очистка после прогона, оставляющая только
`.paperclip-runtime`) и этот каталог не синхронизирует; удаляется лишь
`.paperclip-runtime/runs/`. Хранилище в `/workspace/.pnpm-store` такой защиты не
имело бы. Те же доводы — в заголовке `omp-ssh/compose.yml`.

`clone-or-copy` заставляет pnpm делать рефлинк из хранилища там, где файловая
система его поддерживает (XFS с включённым reflink), и копировать в остальных
случаях. pnpm 9 не падает, когда рефлинк или ссылка отклонены, каким бы ни был
метод: он молча копирует. Ничто здесь не превращает отсутствие рефлинка в
ошибку, поэтому проверяйте по диску.

Приёмку измеряйте по диску, а не по `du`: `du` считает файл с рефлинком или
жёсткой ссылкой по каждому пути, где он встречается, и показывает намного
больше, чем занято на диске. Снимите на хосте
`df --output=used -B1M <OMP_RUNNER_DATA_DIR>` до и после второй рабочей копии на
том же исполнителе, пока на этот диск больше не пишут другие прогоны и
исполнители. Прирост должен быть заметно меньше 700 МБ (только новые объекты и
пакеты, не второй полный клон с хранилищем); прирост около размера
`node_modules` копии значит, что рефлинка не было и pnpm копировал. Хранилище
только растёт: `pnpm store prune` (от пользователя `paperclip`) убирает пакеты,
которые не использует ни один проект.

Один исполнитель на агента:

1. Создать пару ключей для исполнителя. Закрытый ключ не должен попасть в журналы
   и историю оболочки.
2. Запустить контейнер по `docker/agent-runtime/omp-ssh/compose.yml`. В файле
   переменных задать:
   - `OMP_RUNNER_NAME`;
   - `OMP_RUNNER_IMAGE` — дайджест из успешного подписанного прогона;
   - `OMP_RUNNER_AUTHORIZED_KEYS` — файл открытого ключа;
   - `OMP_RUNNER_NETWORK` — сеть контейнера доски.
   - `OMP_RUNNER_DATA_DIR` — каталог на диске данных ботов, не на корне. В нём подкаталоги `workspace/` (владелец 1000:1000), `home/`, `hostkeys/` и `tmp/` (режим `1777`, как у системного `/tmp`: `install -d -m 1777 <каталог>/tmp`; это `/tmp` контейнера, он лежит на диске данных, чтобы тесты и временные файлы задач не занимали корневой диск хоста; записи старше 24 часов убирает host-gc). Создать все до первого запуска: docker создаёт отсутствующий источник привязки от root. Исполнитель, запущенный до появления `tmp/`: создать каталог, добавить том `tmp` в его compose-файл и пересоздать контейнер. Агенты клонируют и собирают там репозитории, по нескольку гигабайт на каждого.
   - `OMP_RUNNER_CACHE_DIR` (необязательно) — общий кеш пакетов выше; сначала создать его подкаталоги `git`, `pnpm-omp` и `pnpm-store-omp`.

   Лимиты по умолчанию — как у контейнера бота-инженера: 4 ГБ, 1 CPU, 1024 процесса. Команда:
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

### Обновление работающего исполнителя (выкат общего кеша)

Исполнитель, запущенный до появления общего кеша, не имеет монтирований кеша и
его переменных. Для каждого исполнителя по одному, пока у его агента нет
прогона в работе (пересоздание останавливает sshd и любой прогон на нём):

1. Указать в файле переменных исполнителя `OMP_RUNNER_IMAGE` с новым дайджестом
   успешного подписанного прогона.
2. По желанию добавить `OMP_RUNNER_CACHE_DIR=<sharedPackageCachePath доски>`. Без
   строки исполнитель получит собственный кеш в `${OMP_RUNNER_DATA_DIR}/cache` и
   будет работать как раньше.
3. Создать три каталога (на общем пути; иначе docker создаст их от root):
   `install -d -o <uid доски> -m 0755 <OMP_RUNNER_CACHE_DIR>/git`,
   `install -d -o 1000 -g 1000 -m 0755 <OMP_RUNNER_CACHE_DIR>/pnpm-omp` и
   `install -d -o 1000 -g 1000 -m 0755 <OMP_RUNNER_CACHE_DIR>/pnpm-store-omp`.
   Каталог `git` — это каталог зеркал доски; если доска уже зеркалирует туда, он
   существует и ничего не меняется. Каталог `pnpm-store-omp` — общее хранилище
   pnpm (OPE-13018); оно начинается пустым и наполняется при первой установке.
4. Пересоздать: `docker compose -p <имя> --env-file <файл> -f docker/agent-runtime/omp-ssh/compose.yml up -d`.
   Тома `workspace`, `home` и `hostkeys` сохраняются, так что закреплённый ключ
   хоста не меняется и SSH-окружение на доске править не нужно.
5. Проверить: `docker logs <имя> 2>&1 | grep omp-runner:` показывает
   `shared package download cache at /cache/pnpm`,
   `shared pnpm store at /cache/pnpm-store` и
   `git mirrors at /cache/git: N repositories`
   (и нет `WARNING /cache/pnpm is owned by uid`);
   `docker exec -u paperclip <имя> sh -c '. /etc/profile; command -v git; echo $npm_config_store_dir; echo $npm_config_cache_dir; echo $npm_config_cache'`
   печатает `/usr/local/bin/git`, `/cache/pnpm-store` и `/cache/pnpm` дважды.

Хранилище pnpm исполнителя начинается пустым и наполняется при первой установке.

### Перенос работающего исполнителя на общее хранилище pnpm (OPE-13018)

Исполнитель, запущенный до появления общего хранилища, держит своё хранилище
в `/workspace/.paperclip-runtime/pnpm-store`. Entrypoint возвращается к нему,
когда `/cache/pnpm-store` не смонтирован, так что исполнитель работает как
прежде. Перенос — по одному исполнителю, пока у его агента нет прогона в работе
(пересоздание останавливает sshd и любой прогон на нём):

1. Создать общий каталог хранилища на хосте:
   `install -d -o 1000 -g 1000 -m 0755 <OMP_RUNNER_CACHE_DIR>/pnpm-store-omp`.
   Compose-файл исполнителя уже ссылается на него (том добавлен в OPE-13018);
   если compose исполнителя старше этого изменения — сначала обновить его.
2. Пересоздать контейнер (та же команда, что в п. 4 выше). Entrypoint печатает
   `shared pnpm store at /cache/pnpm-store`.
3. Проверить профиль:
   `docker exec -u paperclip <имя> sh -c '. /etc/profile; echo $npm_config_store_dir'`
   печатает `/cache/pnpm-store`.
4. В рабочей копии задачи один раз выполнить `pnpm install`: pnpm наполнит
   общее хранилище из реестра (или из существующего хранилища исполнителя
   через `pnpm store import`, если хочется его посеять). Проверить, что
   установка работает, прежде чем удалять старое хранилище.
5. Удалить хранилище исполнителя:
   `rm -rf <OMP_RUNNER_DATA_DIR>/workspace/.paperclip-runtime/pnpm-store`.
   Оно больше не используется; entrypoint теперь указывает каждую сессию на
   общее монтирование.

Пока все исполнители хоста не перенесены, их старые хранилища остаются на
месте; общее хранилище просто наполняется с первого перенесённого исполнителя.

## Публикация и подпись

Workflow `.github/workflows/agent-runtime-images.yml` запускается при push в `main` и релизных тегах `myr-v*` с затрагивающими его путями изменениями либо вручную через `workflow_dispatch`. При ручном запуске задаётся версия; иначе тег строится как `git-<commit-sha>`. В bake-публикацию явно входят `base`, `opencode`, `pi`, `codex`, `gemini`, `claude`, `omp` и `omp-ssh` (`linux/amd64`; `hermes` не включён в scope). Workflow получает дайджесты опубликованных образов и подписывает их через cosign keyless OIDC с GitHub Actions identity.

Для этого изменения пока не проверены успешный запуск workflow и опубликованные OMP-тег/digest. Перед использованием образа проверьте успешный запуск workflow, фактический digest в GHCR и подпись.
