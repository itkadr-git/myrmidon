# Deploy update history

> Russian version: [deploy-update-history.ru.md](deploy-update-history.ru.md)

The instance settings page keeps the completed deploy journal returned by `GET /api/myrmidon/deploy-jobs`. Each record identifies the image digest, version, commit, deploy mode, maintenance window, result, and any health or rollback failure reason. A health failure is recorded as `auto_rolled_back` when the previous image is restored, or `failed_rollback` when restoration also fails.

The history supports independent filters in the settings UI for mode (`manual`, `auto`, `canary`), status (for example `succeeded`, `auto_rolled_back`, `failed_rollback`, `failed_health`, `aborted`), and outcome (`succeeded`, `rollback`, `aborted`). The API accepts the same filters as query parameters: `mode`, `status`, and `outcome`.

The live job remains visible above the history. History entries are persisted by the deploy-jobs service, so an operator can inspect both successful deployments and rollback outcomes after the operation has finished.
