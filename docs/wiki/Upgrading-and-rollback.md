# Upgrading and rollback

> Русская версия: [Upgrading-and-rollback.ru](Upgrading-and-rollback.ru)

Source:
[`docs/myrmidon/deploy.md`](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/deploy.md)
— the per-release operator notes live in its "Upgrading" section, and the
changelog names the release each change landed in.

## Upgrading

Upgrading uses the same script as installing:

```sh
scripts/myrmidon/deploy/deploy.sh --config /path/to/deploy.env --digest sha256:<new digest>
```

or, for a published release, with digest resolution from the release
manifest (`release-components.json`, uploaded as a release asset):

```sh
scripts/myrmidon/deploy/deploy.sh --config /path/to/deploy.env --release myr-vX.Y.Z
```

What the deploy does, in order:

1. **CI-image gate** — before any action (before `docker pull`, the dump,
   maintenance): only an image built by CI from `main` or a `myr-v*` tag
   passes. There is no bypass flag.
2. **Database dump** — `DUMP_COMMAND` into `DUMP_DIR`; a missing or too
   small file aborts the deploy.
3. **Predeploy check on a database copy** (`MYRMIDON_PREDEPLOY_CHECK=1`,
   default) — the dump is restored into a throwaway Postgres, the new board
   and the new dockergate of the same release are started against the copy,
   `/api/health` must report `ok` with the new version and commit, and the
   walked routes must answer. Any failure stops the deploy **before** the
   maintenance window: production is never touched.
4. **One maintenance window** — the board, dockergate, fleetd and the bot
   image list roll together. A component already on the release image is not
   restarted.
5. **Health proof** — the board by `/api/health` (version and commit),
   dockergate by its log (`self-check ok` / `config_reloaded` naming the new
   binary version and config hash), fleetd by its health probe.
6. **All or nothing** — a component failure inside the window rolls the
   changed components, the dockergate config and the board back together
   (`MYRMIDON_COMPONENT_AUTO_ROLLBACK=1`, default). Bot cards switch in
   batches of at most 5, each bot only while its agent is paused or idle —
   a run is never interrupted.

## Release candidates and final releases (since 1.6.5)

A release goes through a trial run before it becomes **Latest** on GitHub:

1. **RC tag.** `myr-vX.Y.Z-rc.N` builds every component image as
   `X.Y.Z-rc.N`; the GitHub publish goes out as a **pre-release** and never
   moves the `latest` marker.
2. **RC deploy.** `deploy.sh --release myr-vX.Y.Z-rc.N` works like any
   release — deploying the RC *is* the trial run of the release flow.
3. **Production proof.** Health on `X.Y.Z-rc.N`, no new damage in the
   attention list, the fleet takes tasks, bot images applied.
4. **Final tag.** When the RC is accepted, `myr-vX.Y.Z` is tagged on the
   SAME commit — no rebuild; the image workflow re-tags the same images and
   the final release is published, still without `latest`.
5. **Promote to Latest — a separate step**, only when the final release runs
   in production and passed smoke:

   ```sh
   scripts/myrmidon/release/promote-latest.sh --tag myr-vX.Y.Z \
     --health-url https://<board>/api/health --health-token-file <board-key-file>
   ```

   The command refuses if the tag is a candidate, the release is a
   pre-release, the release commit is not on `main`, or the board reports
   any version other than `X.Y.Z`.

## Rollback

```sh
scripts/myrmidon/deploy/rollback.sh --config /path/to/deploy.env                          # to the previous image
scripts/myrmidon/deploy/rollback.sh --config /path/to/deploy.env --to sha256:<64 hex>
scripts/myrmidon/deploy/rollback.sh --config /path/to/deploy.env --local                  # to a local image, without pulling (since 1.6.0)
```

- The rollback returns the image and verifies health against the old image's
  labels. **The database is not restored** by default; restoring is a
  separate, explicit path (`--restore-dump` with `RESTORE_COMMAND`, the
  script asks to type `RESTORE`).
- Rollback does not need a live board and is **not** blocked by the
  CI-images-only gate: it is the emergency path.
- A board rollback does not roll back the components, and a component
  rollback does not touch the board.
- **Automatic rollback by health** (`AUTO_ROLLBACK=1`, default since 1.4.0):
  when a deploy started from the board interface fails its health check, the
  host executor immediately runs `rollback.sh` to the image the deploy
  remembered before the switch.
