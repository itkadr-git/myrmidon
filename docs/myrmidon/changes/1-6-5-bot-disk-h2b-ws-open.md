---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
---

## changelog-en

### `myr-ws open`: a task copy is a worktree of the bot's base, refused under disk pressure (1.6.5 BOT-DISK-H, part H2b)

- `myr-ws open <KEY> [owner/repo] [--base <ref>] [--scratch <name>] [--json]`
  creates `/workspace/<KEY>` as a git worktree of the bot's class-D base on the
  branch `bot/<KEY>`: the copy has no object store of its own, so it weighs the
  working tree and an index, not a clone. `--scratch <name>` makes
  `/scratch/<name>` (a detached worktree with a repository, an empty directory
  without).
- `open` is idempotent: a registered copy is returned as it is (`reused: true`);
  a branch `bot/<KEY>` left by an earlier copy is reattached, not reset. Every
  new copy is written to `ws-registry.json`.
- Before creating anything `open` reads `disk-state.json`; with `pressure: hard`
  it exits with code 3 and `BOT_DISK_QUOTA_EXCEEDED:` and names the five
  largest registered copies to close. A missing, broken or stale (older than two
  botd ticks) file counts as no pressure. Reusing an existing copy is never
  refused.
- A key must look like `PREFIX-123`, a scratch name may hold only letters,
  digits, `.`, `_`, `-`; anything with `/` or `..` is refused with code 2.

## changelog-ru

### `myr-ws open`: копия задачи — worktree базы бота, отказ при давлении на диск (1.6.5 BOT-DISK-H, часть H2b)

- `myr-ws open <KEY> [owner/repo] [--base <ref>] [--scratch <name>] [--json]`
  создаёт `/workspace/<KEY>` как worktree базы бота (класс D) на ветке
  `bot/<KEY>`: у копии нет своего каталога объектов, она весит рабочее дерево и
  индекс, а не клон. `--scratch <name>` создаёт `/scratch/<name>` (отсоединённый
  worktree, если указан репозиторий; пустой каталог — если нет).
- `open` идемпотентна: зарегистрированная копия возвращается как есть
  (`reused: true`); ветка `bot/<KEY>` от прежней копии подключается заново, а не
  сбрасывается. Каждая новая копия записывается в `ws-registry.json`.
- Перед созданием `open` читает `disk-state.json`; при `pressure: hard`
  завершается с кодом 3 и текстом `BOT_DISK_QUOTA_EXCEEDED:` и называет пять
  самых больших зарегистрированных копий, которые стоит закрыть. Нет файла,
  он повреждён или устарел (старше двух тактов botd) — давления нет. Повторное
  открытие уже существующей копии не отказывается никогда.
- Ключ должен выглядеть как `PREFIX-123`, имя scratch — только буквы, цифры,
  `.`, `_`, `-`; всё с `/` или `..` отклоняется с кодом 2.

## divergence

| 1.6.5-BOT-DISK-H2b | Команда `open` утилиты `myr-ws`: worktree базы вместо клона, реестр копий, отказ по `disk-state.json` | Наши файлы: `docker/bot-runtime/myr-ws/lib/open.js`, `docker/bot-runtime/myr-ws/package.json`, `scripts/myrmidon/bot-runtime/myr-ws-open.test.mjs`. Маркеров вендора нет: все файлы наши | Проект диска ботов (эпик BOT-DISK-H, раздел 2): копия задачи — объект доски с жизненным циклом, а не каталог, который бот завёл сам. Задача OPE-5344 | `myr-ws-open.test.mjs` (worktree без каталога объектов, идемпотентность, схемы контракта, давление hard, ключи с `/` и `..`) | Никогда, наше поведение. Снятие: удалить `docker/bot-runtime/myr-ws/lib/open.js` и тест | (этот PR) |
