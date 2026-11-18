# Quick start

> Русская версия: [Quick-start.ru](Quick-start.ru)

> The pinned command below stays on rc.13 until a newer release is promoted. Production runs the rc.20 candidate (health answers commit `2c9ebcf1`); the next candidate is proposed as the untagged `rel/1.6.6-fixes` merge `2b5dadeb` — not deployed, not a stable release. See the [operator notes](../myrmidon/releases/1.6.9.md).

The shortest path to a running board. One command on a fresh server (see
[System requirements](System-requirements)):

```sh
curl -fsSL https://github.com/itkadr-git/myrmidon/releases/download/myr-v1.6.9-rc.13/install.sh | sudo bash -s -- --version myr-v1.6.9-rc.13
```

The command pins the release candidate 1.6.9-rc.13; see
[Installation](Installation) for release selection. The installer checks
the machine, installs Docker when it is missing, downloads the release,
creates all secrets and starts the service. At the end it prints the board
address.

Open the printed address in a browser and create an account — the first
account becomes the administrator of the server. Then add a model and create
the first agent in the interface: from its card the board creates and
maintains its isolated container (see
[Settings in the interface](Settings-in-the-interface)).

Details, options and the failure playbook:
[Installation](Installation). Next:
[Upgrading and rollback](Upgrading-and-rollback).
