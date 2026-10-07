---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
settings-section: 1.6.1 — BOT-DISK B: shared package cache for bot containers
---

## changelog-en

### Parser of `git clone` arguments for the bot git wrapper (1.6.5 BOT-DISK-H, part H1a)

- New pure module `docker/bot-runtime/git-reference/clone-args.js` (no dependencies):
  from the arguments of `git clone` it tells a GitHub repository (https, ssh, scp-like,
  with or without `.git`, with or without a token in the URL) from any other host
  (`kind: "foreign"`, the real git runs) and returns `{kind, owner, repo, dir,
  ignoredFlags, hadUserinfo}`. The URL, the token and option values never enter the
  result. Nothing is wired in yet: the wrapper switches over in part H1c.

## changelog-ru

### Разбор аргументов `git clone` для обёртки git ботов (1.6.5 BOT-DISK-H, часть H1a)

- Новый чистый модуль `docker/bot-runtime/git-reference/clone-args.js` (без
  зависимостей): по аргументам `git clone` отличает репозиторий GitHub (https, ssh,
  scp-стиль, с `.git` и без, с токеном в URL и без) от любого другого хоста
  (`kind: "foreign"`, работает настоящий git) и возвращает `{kind, owner, repo, dir,
  ignoredFlags, hadUserinfo}`. URL, токен и значения опций в результат не попадают.
  Пока никуда не подключён: обёртка переходит на него в части H1c.

## divergence

| 1.6.5-BOT-DISK-H1a | Чистый разбор аргументов `git clone` (`clone-args.js`) | Наш новый файл `docker/bot-runtime/git-reference/clone-args.js` и тест; вендорского кода нет | Основа перехвата `git clone` → `myr-ws open` | `clone-args.test.mjs` | Никогда, наше поведение | (этот PR) |
