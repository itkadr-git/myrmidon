---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
settings-section: 1.6.1 — BOT-DISK B: shared package cache for bot containers
---

## changelog-en

### A broken nested `.git` is not a repository: archived as files, the closed task directory goes (1.6.5 BOT-DISK-H)

- `archive-remove` of a closed task directory failed with `archive-incomplete: nested repository repo: bundle create failed: fatal: Need a repository to create a bundle` when a `.git` directory inside it was hollowed out by an old cleanup. botd now treats a `.git` that fails `git rev-parse --git-dir` as no repository: no bundle or patch is made, its files (without `.git`) go into the parent's `dir.tar`, and the directory is removed once the tar is verified. A real repository whose bundle fails is still kept.

## changelog-ru

### Битый вложенный `.git` — не репозиторий: архивируется как файлы, каталог закрытой задачи удаляется (1.6.5 BOT-DISK-H)

- `archive-remove` каталога закрытой задачи падал с `archive-incomplete: nested repository repo: bundle create failed: fatal: Need a repository to create a bundle`, когда внутри лежал `.git`, опустошённый старой чисткой. Теперь botd считает `.git`, не проходящий `git rev-parse --git-dir`, отсутствием репозитория: bundle и patch не делаются, файлы (без `.git`) попадают в `dir.tar` родителя, каталог удаляется после проверенного tar. Настоящий репозиторий с ошибкой bundle по-прежнему не удаляется.

## divergence

| 1.6.5-BOT-DISK-H-broken-nested-git | вложенный или собственный `.git`, не проходящий `git rev-parse --git-dir`, не считается репозиторием (`findNestedGit`, `archiveThenRemove`) | Наши файлы: `docker/bot-runtime/botd/lib/legacy.js` и тесты. Маркеров вендора нет | `archive-remove` закрытой задачи падал на опустошённом `.git` (bundle create failed) | `botd-legacy.test.mjs`, `botd-policy.test.mjs` | Никогда, наше поведение | (этот PR) |
