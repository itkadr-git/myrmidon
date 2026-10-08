# Installation

> Русская версия: [Installation.ru](Installation.ru)

One command brings a clean server to a working Myrmidon board. Copy it onto
the server and run it — the installer does the rest itself:

```sh
curl -fsSL https://github.com/itkadr-git/myrmidon/releases/latest/download/install.sh | sudo bash
```

That link always serves the installer of the latest release. The command
needs an internet connection and `curl` (on a bare Ubuntu or Debian,
`sudo apt-get install -y curl` adds it).

## What the installer does, step by step

1. **Checks the machine** against the
   [System requirements](System-requirements) and says in plain words what is
   missing — it stops there rather than failing halfway.
2. **Installs Docker** and the compose plugin, if they are not there yet
   (from the official Docker repository).
3. **Picks the latest release** and downloads exactly its files — the same
   ones that passed the release checks. A release stays byte-identical
   forever, so tomorrow's install of the same version matches today's.
4. **Creates all secrets** (the database password and the board's internal
   keys) and writes the configuration into `/opt/myrmidon`. Nothing to fill
   in by hand; the secrets file is readable only by root.
5. **Downloads the program images and starts the service**: the database,
   the board and the part that will later run agents.
6. **Waits until the board answers** and then prints a summary.

The whole run takes a few minutes, most of it on step 5. The installer asks
no questions; `--interactive` enables three of them (install directory, port,
the address the board is opened at).

## What you see at the end

A summary like this:

```
Myrmidon 1.6.6 is installed and answering.

  Address:            http://my-server:3100
  First administrator: open http://my-server:3100 , create an account — the
                       first account becomes the administrator of this instance.
  Files:              /opt/myrmidon
```

Open the printed address in a browser and create an account — the first
account on the server becomes its administrator. From there the board is
ready: add a model and create the first agent in the interface (see
[Settings in the interface](Settings-in-the-interface)).

## Which database the installer gives you

By default the installer raises a small PostgreSQL server in a container
next to the board and creates the board's database there — enough for a
first look and for small installations.

Since release 1.6.5 the board can also keep its database on a **shared
PostgreSQL 18 server** — one server, prepared by your administrator, that
hosts a separate database and role for each program that needs one (the
board, the LLM gateway, tracing, agent memory). The server needs
PostgreSQL 18 with the `pgvector` extension installed; the board uses
only its own database and role and cannot see the neighbors' data.

To place the board's database on such a server instead of the bundled
container, give the installer the connection string your administrator
prepared (`postgres://user@host:5432/database`) as the installer's
database-address parameter — the installer names the parameter itself in
its help and interactive prompts. The password is not part of the
connection string on the command line: the installer asks for it at run
time, or reads it from the standard PostgreSQL environment variable.

The connection string names the board's own database and role on the
shared server; your administrator creates both beforehand. How the board
treats the shared server on updates and backups (and what changes for the
host's PostgreSQL client tools) is described in
[Upgrading and rollback](Upgrading-and-rollback). The one-line install
command without options keeps using the bundled database container.

## If a step fails

The installer stops at the failed step and says why in plain language —
for example, that there is less memory than needed or the port is taken.
Fix what it names and run the same command again: the installer is safe to
re-run and continues from a clean state. If the board did not come up, the
last lines of its log are printed right there.

## Useful options

- `install.sh --version myr-vX.Y.Z` — install a specific release instead of
  the latest.
- `install.sh --dir /srv/myrmidon --port 8080` — a different directory or
  port (both also offered by `--interactive`).
- `install.sh --lang ru` / `--lang en` — the installer's messages follow the
  system locale; this overrides it.

To use an option with the one-line form, download the script first:

```sh
curl -fsSL -O https://github.com/itkadr-git/myrmidon/releases/latest/download/install.sh
sudo bash install.sh --version myr-vX.Y.Z
```

## Updating and removing

- **Update:** run the same one-line command again. The installer dumps the
  database first, switches to the new release, checks that the board answers,
  and returns to the previous release on its own if the new one does not come
  up. Details: [Upgrading and rollback](Upgrading-and-rollback).
- **Stop and remove:** `sudo bash install.sh --uninstall` stops the service
  and keeps the data; `--uninstall --purge` also deletes the database and the
  install directory.

## For experienced administrators

A hands-on rollout through `deploy.sh` — the maintenance-window flow the
production server uses — lives on a separate page:
[Manual deployment](Manual-deployment). A fresh install does not need it.
