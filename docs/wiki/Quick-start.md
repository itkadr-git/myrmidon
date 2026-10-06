# Quick start

> Русская версия: [Quick-start.ru](Quick-start.ru)

The shortest path, condensed from [Installation](Installation) — read the
full page before a real install.

1. Prepare a host: bash 4+, Docker with the `compose` and `buildx` plugins,
   `curl`, `jq`, `git`, and a clone of this repository (see
   [System requirements](System-requirements)).
2. Copy
   [`scripts/myrmidon/deploy/deploy.env.example`](https://github.com/itkadr-git/myrmidon/blob/main/scripts/myrmidon/deploy/deploy.env.example)
   to a private deploy repository and fill it in.
3. Pick the release digest from the Actions **Myrmidon image** workflow (or
   `docker buildx imagetools inspect`), then:

   ```sh
   scripts/myrmidon/deploy/deploy.sh --config /path/to/deploy.env --digest sha256:<digest> --dry-run
   scripts/myrmidon/deploy/deploy.sh --config /path/to/deploy.env --digest sha256:<digest>
   ```

4. Check the board: `curl http://127.0.0.1:3100/api/health` reports the
   version (`myr-v…`). Open the board in the browser and finish the setup
   (models, agents, channels) in the interface.

Next: [Upgrading and rollback](Upgrading-and-rollback),
[Settings in the interface](Settings-in-the-interface).
