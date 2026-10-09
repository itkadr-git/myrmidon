---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
settings-section: 1.6.1 — BOT-DISK B: shared package cache for bot containers
---

## changelog-en

### The bot git wrapper turns `git clone` into `myr-ws open` and strips credentials from remote URLs (1.6.5 BOT-DISK-H, part H1b)

- `git clone <GitHub repository> [dir]` (https, ssh, scp-like, with or without a token
  in the URL) no longer clones: the wrapper runs `myr-ws open` (key from
  `MYRMIDON_TASK_WORKSPACE`, otherwise `--scratch <dir name>`), so the copy is a worktree of
  the bot's shared base. `--filter`, `--depth`, `--mirror`, `--bare` and the other
  history options are dropped with a line on stderr. The exit code and stderr of `myr-ws`
  (3 = quota) are passed through. A clone of another host, a missing `myr-ws` or
  `clone-args.js`, or `MYRMIDON_GIT_INTERCEPT=0` keeps the previous behaviour.
  `MYRMIDON_WS_BIN` replaces the `myr-ws` binary.
- `git remote add|set-url` and `git config remote.<name>.url|pushurl` with a credential
  in the URL are rewritten without it. The wrapper loads `clone-args.js` lazily when H1a
  later ships it in the image and parses the argv itself while the file is absent.

## changelog-ru

### Обёртка git ботов превращает `git clone` в `myr-ws open` и убирает токен из URL remote (1.6.5 BOT-DISK-H, часть H1b)

- `git clone <репозиторий GitHub> [dir]` (https, ssh, scp-стиль, с токеном в URL и без)
  больше не клонирует: обёртка вызывает `myr-ws open` (ключ — из
  `MYRMIDON_TASK_WORKSPACE`, иначе `--scratch <имя каталога>`), копия — worktree общей базы
  бота. `--filter`, `--depth`, `--mirror`, `--bare` и прочие опции истории отбрасываются со
  строкой в stderr. Код выхода и stderr `myr-ws` (3 — квота) пробрасываются. Клон другого
  хоста, отсутствие `myr-ws` или `clone-args.js`, `MYRMIDON_GIT_INTERCEPT=0` — прежнее
  поведение. `MYRMIDON_WS_BIN` подменяет бинарь `myr-ws`.
- `git remote add|set-url` и `git config remote.<имя>.url|pushurl` с учёткой в URL
  переписываются без неё. `clone-args.js` обёртка подхватывает лениво, когда H1a положит
  его в образ, а пока файла нет — разбирает argv сама.

## divergence

| 1.6.5-BOT-DISK-H1b | Обёртка git ботов: `clone` репозитория GitHub открывает копию через `myr-ws open` (ключ из `MYRMIDON_TASK_WORKSPACE`, иначе `--scratch <имя каталога>`), `--filter`/`--depth`/`--mirror`/`--bare` и прочие опции истории отбрасываются со строкой в stderr, код выхода и stderr `myr-ws` (3 — квота) пробрасываются; `remote add\|set-url` и `config remote.<имя>.url\|pushurl` с учёткой в URL переписываются без неё; не-GitHub и неразобранный argv — настоящий git без изменений argv/stdio/кода | Наши файлы: `docker/bot-runtime/git-reference/git`, `scripts/myrmidon/bot-runtime/git-reference.test.mjs`; маркеров вендора нет — все файлы наши | Диск ботов дошёл до 100 %: своя полная копия репозитория на каждую задачу, копия должна быть участком общей базы бота, а токен не должен оставаться в конфиге remote. Требование OPE-5347 (часть H1b проекта BOT-DISK-H, родитель OPE-5308) | `scripts/myrmidon/bot-runtime/git-reference.test.mjs` (15 форм clone уходят в `myr-ws open` с верными аргументами, настоящий `git clone` не вызван, promisor/`--filter` не доходят до git, код 3 и stderr `myr-ws` пробрасываются, `remote.*.url` с токеном санируется на настоящем git, не-GitHub — прежние argv/stdio/код выхода) | Никогда, наше поведение. Снятие: удалить блок `myrmidon(1.6.5 BOT-DISK-H1b)` из обёртки, вернуть прежний `clone` и прежний проброс argv, снять санацию remote, удалить тест и фрагмент | (этот PR) |
