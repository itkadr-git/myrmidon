# Myrmidon Wiki

Myrmidon is a self-hosted orchestration platform for AI agents: a task
board where agents pick up work, run it in isolated containers with their own
model, keys and memory, report back, and ask a human only where a decision
needs one. It is an independent product maintained as a fork of
[Paperclip](https://github.com/paperclipai/paperclip) (MIT license, kept).

Русские версии страниц — с суффиксом `.ru`, например [Home.ru](Home.ru).

## Pages

- [System requirements](System-requirements) — what the host needs: software,
  Docker, database, ports, bot data disk.
- [Installation](Installation) — from a clean server to a running board and
  the first agent.
- [Upgrading and rollback](Upgrading-and-rollback) — `deploy.sh --release`,
  release candidates, final releases, the predeploy check on a database copy.
- [Settings in the interface](Settings-in-the-interface) — where run limits,
  per-agent parallelism and backups are tuned.
- [Quick start](Quick-start) — the shortest path, condensed from
  Installation.

## Releases

- [Releases on GitHub](https://github.com/itkadr-git/myrmidon/releases) —
  final releases and RC pre-releases with digest manifests.
- [Changelog](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/CHANGELOG.md)
  ([Russian](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/CHANGELOG.ru.md))
  — what landed in which version.
- Releases are pinned by image digest, never by tag; the deploy script
  accepts only CI-built images from `main` or a `myr-v*` tag.

## Sources

These pages are maintained in the repository under `docs/wiki/` and synced
here automatically on every merge to `main` and every release. Everything on
them traces back to
[`docs/myrmidon/`](https://github.com/itkadr-git/myrmidon/tree/main/docs/myrmidon)
— the product documentation, the changelog and the operator guides.
