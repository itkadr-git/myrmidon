# System requirements

> Русская версия: [System-requirements.ru](System-requirements.ru)

What a server needs to run Myrmidon. The minimum values below are the checks
the installer performs before it touches anything — a machine below them is
refused with a plain-language message. The recommended values come from the
production installation that runs the project itself.

## Operating system and architecture

- **Ubuntu 24.04 or newer, or Debian 13 or newer** — other distributions work
  in principle, but the installer warns that they are untested.
- Architecture **x86_64 or aarch64**.
- `systemd` is expected so the service survives a host reboot.
- Root rights for the installation (the one-line command already runs the
  installer through `sudo`).
- `curl` on a brand-new system; everything else the installer installs
  itself (including Docker and the compose plugin).

## Minimum (checked by the installer)

| Resource | Minimum |
|---|---|
| CPU | 2 cores |
| Memory (RAM) | 4 GB |
| Free disk under `/opt/myrmidon` | 10 GB |
| Port | 3100 free (a different one can be passed as `--port`) |

The minimum runs the board itself comfortably and a few agents.

## Recommended

| Resource | Recommended |
|---|---|
| Board without agents | 4 cores, 8 GB RAM (4 GB for the board, 4 GB for the database), 50 GB disk |
| Each agent on the same host | +1–4 GB RAM and a disk quota for its files |
| Large installation | the project's own production server runs **74 agents on 16 cores / 64 GB RAM** |

A rule of thumb for a host with N agents: 8 GB for the board and the
database, plus 1–4 GB per agent. The board additionally keeps a safety floor:
by default a new agent run starts only while the host has at least 15 GB of
free memory (the `minFreeHostMemoryMb` setting, see
[Settings in the interface](Settings-in-the-interface)).

## Disk layout

- The program and the database live under the install directory
  (`/opt/myrmidon` by default).
- Every agent owns a directory on the host with its working copies and
  profile; its size is capped by a per-agent disk quota set in the interface
  (see [Settings in the interface](Settings-in-the-interface)). Size this
  space for the number of agents and their working copies.
- The board watches the host disk fill itself and raises an attention signal
  at 85 % (critical from 95 %).

## Network

- The board (interface and API) listens on port **3100**; it needs outbound
  internet access to download releases and program images.
- Agents on **other** machines need network access to this board.

## Database

All board state lives in PostgreSQL — the installer brings it up in a
container itself; no separate database server is needed.
