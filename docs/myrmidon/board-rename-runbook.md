# Board container rename runbook (1.6.6)

This procedure is for the operator applying the 1.6.6 release in the rc.17 window. The installer gives the board the stable container name `myrmidon-board` and retains `paperclip-server-1` as a DNS alias on the bot network. Existing bot profiles and external clients using the old hostname therefore continue to resolve during and after the rename. The deploy project name is pinned separately with `COMPOSE_PROJECT_NAME=myrmidon-board`; when unset, Compose keeps the existing directory-derived project identity for existing installations.

## Before the window

1. Confirm the 1.6.6 release image digests and the intended compose files in `deploy.env`; preserve a copy of the current `deploy.env`, compose YAML, and deploy state under the installation's state directory.
2. Confirm the existing project name with `docker compose -f <files> ps` (do not assume it is the directory name) and record the current board container ID, image digest, health response, and `paperclip.service` unit.
3. Check that `paperclip-server-1` resolves from the bot network and that active bot profiles still target it. Confirm sufficient disk space and that the standard dump/restore commands work.
4. Do not rename a running container in place. The change is applied by the normal compose deploy so the old container remains available until the replacement passes health checks.

## Apply in the rc.17 window

1. Enter the approved maintenance window and run the normal `deploy.sh --digest <approved-digest>` procedure. Use the existing `COMPOSE_PROJECT_NAME` value unless this host is explicitly being migrated to the pinned project name; changing the Compose project name can create a second stack and must not be done as an incidental environment edit.
2. When migrating the project name, verify the planned container set and volumes before `up`. Keep the existing project and data volumes intact; do not run `down`, `down -v`, or prune volumes as part of this change.
3. Run `post-boot-check.sh` and require a healthy board, correct image, and DNS checks for both `myrmidon-board` and `paperclip-server-1`. Confirm bot connectivity using a legacy-hostname client as well as the new hostname.
4. Exit maintenance only after all release gates and representative bot checks pass. Retain the old DNS alias through the whole compatibility window; its use must emit a deprecation warning in application/operator logs.

## Rollback

1. If health, DNS, or bot checks fail, keep maintenance enabled. Run the normal deploy rollback procedure using the recorded prior digest and configuration; do not delete the new or old data volumes.
2. Restore the saved `deploy.env`, compose files, and project-name setting if the failure is tied to project discovery. Redeploy the prior digest under the recorded existing project identity.
3. Verify board health, the original container/image identity, database data, bot connectivity through `paperclip-server-1`, and the post-boot checks before leaving maintenance.
4. If rollback cannot restore health, leave maintenance enabled and escalate to the on-duty release operator with the saved state, check report, and container IDs. Do not attempt a second project-name migration in the same window.

## After the window

Record the applied project name, image digest, old and new container IDs, health/DNS check results, and any observed legacy-name use in the release record. Keep the `paperclip-server-1` alias until a separately approved compatibility-removal change verifies all clients have migrated.
