# Manual deployment (deploy.sh)

> Русская версия: [Manual-deployment.ru](Manual-deployment.ru)

The hands-on rollout flow with a maintenance window — the one the production
server uses. **A fresh install does not need this page**: use
[Installation](Installation), one command does everything. This page is for
administrators who run the deploy pipeline by hand. Everything here traces to
[`docs/myrmidon/deploy.md`](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/deploy.md) —
the authoritative version.

## 1. Prepare the host

Check the [System requirements](System-requirements) first. In short:

1. Install bash 4+, Docker with the `compose` and `buildx` plugins, `curl`,
   `jq`, `git`.
2. Clone this repository on the deploy host; its `origin` must point at
   `github.com/itkadr-git/myrmidon` — the deploy script verifies the image
   commit against this clone and refuses to run from anywhere else.
3. Have the Myrmidon server managed by docker compose, with the server image
   set in a separate override file (`COMPOSE_OVERRIDE_FILE`) — the script
   rewrites only the `image:` line there.
4. Prepare the database dump command (`DUMP_COMMAND`) and, for rollback with
   restore, the restore command (`RESTORE_COMMAND`).

## 2. Fill in the settings file

Copy
[`scripts/myrmidon/deploy/deploy.env.example`](https://github.com/itkadr-git/myrmidon/blob/main/scripts/myrmidon/deploy/deploy.env.example)
into a private deploy repository (never into this one) and fill in the real
values: compose project paths, `HEALTH_URL`, `STATE_DIR`, `DUMP_DIR`,
maintenance mode, release components (`MYRMIDON_RELEASE_COMPONENTS`,
default `dockergate,fleetd`), and — for a first install —
`SYSTEMD_UNIT_INSTALL=1` so the canonical boot unit is installed.

In `authenticated` deployment mode, point `HEALTH_TOKEN_FILE` at a `0600`
file with a board API key: without it the version check fails and the deploy
counts as failed, by design.

## 3. Pick the image digest

Releases pin the image **digest**, never a tag. Take it from:

- the summary of the `image` job of the **Myrmidon image** workflow
  (Actions → the run on the release commit or tag), the `Digest` line; or
- the registry:

```sh
docker buildx imagetools inspect ghcr.io/itkadr-git/myrmidon:<version> --format '{{json .Manifest.Digest}}'
```

## 4. Deploy

Dry-run first, then the real run:

```sh
scripts/myrmidon/deploy/deploy.sh --config /path/to/deploy.env --digest sha256:<digest> --dry-run
scripts/myrmidon/deploy/deploy.sh --config /path/to/deploy.env --digest sha256:<digest>
```

For a published release the short form resolves every component digest from
the release manifest itself:

```sh
scripts/myrmidon/deploy/deploy.sh --config /path/to/deploy.env --release myr-vX.Y.Z
```

The script enforces, before anything changes, that the image is CI-built
from `main` or a `myr-v*` tag, restores the predeploy dump into a throwaway
Postgres and proves the new board on it, opens one maintenance window, rolls
the board and the release components together, and verifies health. A
component failure inside the window rolls everything back together
(`MYRMIDON_COMPONENT_AUTO_ROLLBACK=1`, the default).

## 5. Verify the board is up

```sh
curl http://127.0.0.1:3100/api/health
```

The response must report `status: ok` and the version (`myr-v…`) — in
`authenticated` mode pass the board key. Then open the board in the browser
and finish the setup in the interface: models and agents on their cards, the
autonomy matrix and the member list in Company Settings. That is where the
first agent is created and given its model and keys — from its card the
board creates and maintains its isolated container (see
[Settings in the interface](Settings-in-the-interface)).

## 6. Day two

- Updates and rollbacks use the same script — see
  [Upgrading and rollback](Upgrading-and-rollback).
- Instance-wide switches (`MYRMIDON_*`) are documented in
  [SETTINGS.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/SETTINGS.md).
