---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
settings-section: 1.6.1 — BOT-DISK B: shared package cache for bot containers
---

## changelog-en

### A broken nested `.git` is not a repository: archived as files, the closed task directory goes (1.6.5 BOT-DISK-H)

- `archive-remove` of a closed task directory failed with `archive-incomplete: nested repository repo: bundle create failed: fatal: Need a repository to create a bundle` when a `.git` directory inside it was hollowed out by an old cleanup. botd now treats a `.git` that fails `git rev-parse --git-dir` as no repository: no bundle or patch is made, its files (without `.git`) go into the parent's `dir.tar`, and the directory is removed once the tar is verified. A real repository whose bundle fails is still kept.
