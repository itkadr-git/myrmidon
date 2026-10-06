---
divergence-section: 1.6.2 — RUN-ADMISSION: допуск прогонов по свободной памяти хоста и плавный старт
---

## changelog-en

### Several GitHub identities per bot, scoped by repository owner (1.6.5 GITHUB-OWNER-IDENTITIES)

- A container bot card (`hermes_gateway` adapter) can now carry several
  GitHub identities instead of one instance-wide credential:
  `adapterConfig.githubIdentities` is a list of entries, each binding a
  repository owner to a company secret — for example
  `{owner: "example-org-a", secretName: "github-bot-example-org-a"}` and
  `{owner: "example-org-b", secretName: "github-bot-example-org-b"}`. Each
  token is resolved from its secret with an access-audit entry
  (`consumerType: "agent"`, the agent's id) and is written into the bot's
  profile (`hermes/.env`) as a per-owner variable derived from the owner
  name (`GH_TOKEN_<OWNER>`, uppercased, non-alphanumeric replaced by `_`),
  never as `GH_TOKEN`/`GITHUB_TOKEN`, so it cannot collide with the
  board-managed credential path.
- Inside the container, `git` and `gh` pick the identity by the repository
  URL: `/etc/gitconfig` carries a URL-scoped credential helper per
  configured owner (`https://github.com/<owner>/`), and the `gh` wrapper
  chooses the token by the owner parsed from the command arguments or
  `GH_HOST`. The effective boundary is technical, not procedural: the
  per-owner token simply has no rights to another owner's repositories, so
  a push — and a fork creation — into the wrong owner's namespace is
  refused by GitHub itself.
- The bot container's entrypoint prints a self-check at start: which
  identity (login only, never the token) answers for each configured
  owner, so a misbound card is visible in the log before the first push.
- The agent card UI shows the list of identities with their scopes
  (owner, login, secret name), read-only; the list is managed through the
  agent record, not from the card form.
- The previous single-token path
  (`MYRMIDON_BOT_CONTAINER_GITHUB_ENV_ALLOWLIST` plus `GH_TOKEN` /
  `GITHUB_TOKEN` in the card's `env`) keeps working unchanged for cards
  without `githubIdentities` and is now deprecated: new setups should use
  per-owner identities.

## changelog-ru

### Несколько GitHub-учёток у бота с областями по владельцу репозитория (1.6.5 GITHUB-OWNER-IDENTITIES)

- Карточка контейнерного бота (адаптер `hermes_gateway`) теперь может
  нести несколько GitHub-учёток вместо одного токена на весь инстанс:
  `adapterConfig.githubIdentities` — список записей, каждая привязывает
  владельца репозитория к секрету компании. Например,
  `{owner: "example-org-a", secretName: "github-bot-example-org-a"}` и
  `{owner: "example-org-b", secretName: "github-bot-example-org-b"}`.
  Каждый токен резолвится из своего секрета с записью в аудите доступа
  (`consumerType: "agent"`, id агента) и попадает в профиль бота
  (`hermes/.env`) как отдельная переменная, производная от имени владельца
  (`GH_TOKEN_<OWNER>`, в верхнем регистре, не-буквенно-цифровые символы
  заменены на `_`), а не как `GH_TOKEN`/`GITHUB_TOKEN`, чтобы не
  конфликтовать с управляемым доской путём учётных данных.
- В контейнере `git` и `gh` выбирают учётку по URL репозитория:
  `/etc/gitconfig` несёт URL-scoped credential helper для каждого
  настроенного владельца (`https://github.com/<owner>/`), а обёртка `gh`
  выбирает токен по владельцу, разобранному из аргументов команды, или по
  `GH_HOST`. Граница действует технически, а не по инструкции: токен
  одного владельца просто не имеет прав на репозитории другого, поэтому
  push — и создание форка — в чужое пространство имён отклоняет сам
  GitHub.
- При старте контейнера entrypoint выводит самопроверку: какая учётка
  (только логин, без токена) отвечает за каждого настроенного владельца —
  неверно привязанная карточка видна в логе до первого push.
- В интерфейсе карточки агента отображается список учёток с областями
  (владелец, логин, имя секрета), только чтение; список управляется через
  запись агента, а не из формы карточки.
- Прежний путь с одним токеном
  (`MYRMIDON_BOT_CONTAINER_GITHUB_ENV_ALLOWLIST` плюс `GH_TOKEN` /
  `GITHUB_TOKEN` в `env` карточки) продолжает работать без изменений для
  карточек без `githubIdentities` и теперь помечен как deprecated: новые
  настройки — через учётки по владельцам.

## divergence

| GITHUB-OWNER-IDENTITIES | Карточка контейнерного бота несёт несколько GitHub-учёток с областями по владельцу репозитория (`adapterConfig.githubIdentities`: владелец → секрет компании); токены резолвятся в профиль бота как переменные `GH_TOKEN_<OWNER>` (не `GH_TOKEN`/`GITHUB_TOKEN`), `git` и `gh` в контейнере выбирают учётку по URL репозитория (URL-scoped credential helpers в `/etc/gitconfig`, обёртка `gh` по владельцу из аргументов), entrypoint при старте печатает самопроверку — какой логин отвечает за каждого владельца, без токенов; push в чужое пространство владельца и форк в него невозможны технически (нет прав у токена); карточка агента показывает список учёток (владелец, логин, имя секрета) только на чтение; прежний путь (`MYRMIDON_BOT_CONTAINER_GITHUB_ENV_ALLOWLIST` + `GH_TOKEN`/`GITHUB_TOKEN` в `env` карточки) работает и помечен deprecated | `server/src/myrmidon/bot-containers/card-env.ts`, `server/src/myrmidon/bot-containers/profile-compiler.ts`, `server/src/myrmidon/bot-containers/profile-compile.ts`, `server/src/myrmidon/bot-containers/profile-input.ts`, `packages/shared/src/types/` (тип `githubIdentities`), `server/src/routes/agents.ts`, `docker/bot-runtime/github-broker/{git-credential-paperclip,gh}`, `docker/bot-runtime/Dockerfile`, `docker/bot-runtime/entrypoint.sh`, `ui/src/components/myrmidon/` (поля карточки) | Правило владельца: каждый продукт публикуется от своей учётки GitHub; бот инженеров работает с обоими продуктами, а в контейнер попадал один токен — отсюда запрещённый форк продукта под чужой учёткой (94 PR, удаляется) | `server/src/myrmidon/bot-containers/card-env.myrmidon.test.ts`, `server/src/myrmidon/bot-containers/profile-compiler.myrmidon.test.ts`, `docker/bot-runtime/github-broker/gh.test.mjs`, `docker/bot-runtime/entrypoint.test.sh` | Никогда, наше поведение. Снятие — удалить перечисленные точки и вернуться к одному токену на бота | (этот PR) |

## settings-en-append

<!-- section: Settings in the agent record (not environment variables) -->
| `adapterConfig.githubIdentities` | GITHUB-OWNER-IDENTITIES | absent (the card has one or no GitHub identity) | List of GitHub identities of a container bot (`hermes_gateway` adapter), each entry binds a repository owner to a company secret (`one entry per owner: the owner name and the company secret name, e.g. owner `example-org-a` with secret `github-bot-example-org-a`). The secret value is a fine-grained token for that owner's repositories; it is resolved per owner into the bot's `hermes/.env` as `GH_TOKEN_<OWNER>` (the owner name uppercased, non-alphanumeric replaced by `_`), and `git`/`gh` inside the container pick the identity by the repository URL. The UI shows the list (owner, login, secret name) read-only. Replaces the deprecated single-token path (`MYRMIDON_BOT_CONTAINER_GITHUB_ENV_ALLOWLIST` + `GH_TOKEN`/`GITHUB_TOKEN` in `env`, which still works for cards without the field) | Absent or an empty list — the card keeps the previous behavior. An entry whose owner has no secret bound fails the profile build with a log entry, not a silent fallback |

## settings-ru-append

<!-- section: Настройки в записи агента (не переменные окружения) -->
| `adapterConfig.githubIdentities` | GITHUB-OWNER-IDENTITIES | отсутствует (у карточки одна GitHub-учётка или ни одной) | Список GitHub-учёток контейнерного бота (адаптер `hermes_gateway`); каждая запись привязывает владельца репозитория к секрету компании: `one entry per owner: the owner name and the company secret name, e.g. owner `example-org-a` with secret `github-bot-example-org-a``. Значение секрета — fine-grained токен для репозиториев этого владельца; токен резолвится в `hermes/.env` бота как `GH_TOKEN_<OWNER>` (имя владельца в верхнем регистре, не-буквенно-цифровые символы заменены на `_`), а `git`/`gh` в контейнере выбирают учётку по URL репозитория. В интерфейсе карточки список (владелец, логин, имя секрета) показан только на чтение. Заменяет устаревший путь с одним токеном (`MYRMIDON_BOT_CONTAINER_GITHUB_ENV_ALLOWLIST` + `GH_TOKEN`/`GITHUB_TOKEN` в `env`; он продолжает работать для карточек без этого поля) | Поле отсутствует или список пуст — карточка ведёт себя как раньше. Запись, для владельца которой не привязан секрет, роняет сборку профиля с записью в журнале, а не тихим откатом |
