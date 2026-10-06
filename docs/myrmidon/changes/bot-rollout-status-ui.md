## settings-en-new

<!-- after: Track 5 — operations -->

### BOT-ROLLOUT — release bot-image rollout status and settings (1.6.5, part B)

| Variable / key | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_BOT_RELEASE_IMAGE` | BOT-ROLLOUT | unset | The release's bot image reference the board knows (any of the three bot image repositories, digest-pinned): the status API (`GET /api/myrmidon/agents/:id/bot-container/status`, field `imageRollout`) reports a real on/off-the-current-image verdict only when this is set | Unset — a tracking bot reports `no release image configured`; the rollout script keeps resolving the exact release image from the registry at deploy time |
| `MYRMIDON_BOT_IMAGE_ROLLOUT_BUSY_SOFT_PAUSE_SEC` | BOT-ROLLOUT | `0` | Soft pause after a busy bot before the batch moves on (part of the rollout settings) | `0` — off; the UI override cannot exceed the env value |
| `instance_settings.general.myrmidonBotImageRollout` | BOT-ROLLOUT | unset | The rollout settings edited from the instance settings page (`GET`/`PATCH /api/myrmidon/bot-image-rollout`): `botTimeoutSec` (busy-bot wait, 10..86400), `batchSize` (1..5), `busySoftPauseSec` (0..3600). Each env variable stays the default AND the upper bound — a stored value past the env cap reads as the cap | Unset/absent — the env value (or the module default) applies; an unreadable object reads as absent |
