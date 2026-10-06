---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
---

## changelog-en

### The bot card shows which GitHub accounts the bot may act as (1.6.5-GITHUB-IDENTITIES-C)

- The agent card of a `hermes_gateway` bot carries a read-only "GitHub identities"
  section: every account from `adapterConfig.githubIdentities` with the repository
  owner it is scoped to (`<owner>/*`), the login the token belongs to and the name of
  the company secret the container resolves the token from. The container picks the
  account by the repository URL, so a push outside those owners is impossible rather
  than merely discouraged, and the card is where an operator sees who the bot pushes
  under without reading `adapterConfig` by hand.
- The list is not editable on the card: it is written through the API and the secrets
  it names. An entry without an owner or without a secret name is reported next to the
  list instead of being shown half-read, and two entries claiming the same owner are
  flagged, because the container can resolve only one account per owner.
- A card without identities says so and keeps the previous behaviour: the bot uses the
  single GitHub token from its card environment.

## changelog-ru

### Карточка бота показывает, под какими GitHub-учётками он может действовать (1.6.5-GITHUB-IDENTITIES-C)

- В карточке бота `hermes_gateway` появился раздел «GitHub identities» только для
  чтения: все учётки из `adapterConfig.githubIdentities` с владельцем репозиториев,
  на которые распространяется учётка (`<owner>/*`), логином и именем секрета компании,
  из которого контейнер берёт токен. Контейнер выбирает учётку по URL репозитория,
  поэтому push за пределы этих владельцев невозможен технически, а карточка — то место,
  где оператор видит, под кем бот пушит, не читая `adapterConfig` руками.
- Список на карточке не редактируется: он пишется через API и секреты, которые он
  называет. Запись без владельца или без имени секрета показывается сообщением рядом
  со списком, а не половиной строки; две записи на одного владельца помечаются — на
  одного владельца контейнер может разрешить только одну учётку.
- Карточка без учёток говорит об этом прямо и сохраняет прежнее поведение: бот
  пользуется единственным GitHub-токеном из окружения карточки.

## divergence

| 1.6.5-GITHUB-IDENTITIES-C | Раздел «GitHub identities» на карточке бота: список учёток из `adapterConfig.githubIdentities` с областью `<owner>/*`, логином и именем секрета; только для чтения (правка — через API и секреты); пустой список — прежний путь с одним токеном в окружении карточки; запись без владельца или секрета и повтор владельца показываются сообщениями рядом со списком | `ui/src/components/AgentConfigForm.tsx` (импорт + раздел карточки, метка `myrmidon(GITHUB-IDENTITIES-C)`) + `ui/src/components/myrmidon/AgentCardGitHubIdentitiesFields.tsx` | Карточка бота должна нести несколько GitHub-учёток с областью по владельцу репозитория: оператору нужен видимый список «под кем бот пушит» и честное состояние карточки, а не сырой `adapterConfig` | `ui/src/components/myrmidon/AgentCardGitHubIdentitiesFields.myrmidon.test.tsx` (список учёток с областью/логином/секретом; отсутствующий логин не выдумывается; неполные записи и повтор владельца — сообщениями; пустой список — пустая секция; ни одного поля ввода) | Никогда, наше поведение. Снятие: убрать раздел карточки и файлы компонента; поле `githubIdentities` и токены остаются за серверной частью | (этот PR) |