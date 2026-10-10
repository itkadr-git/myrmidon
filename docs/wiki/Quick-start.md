# Quick start

> Русская версия: [Quick-start.ru](Quick-start.ru)

The shortest path to a running board. One command on a fresh server (see
[System requirements](System-requirements)):

```sh
curl -fsSL https://github.com/itkadr-git/myrmidon/releases/download/myr-v1.6.5-rc.15/install.sh | sudo bash
```

Until the 1.6.5 final ships, the command installs the current release
candidate (see [Installation](Installation) for why). The installer checks
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
