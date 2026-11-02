# Hermes bot session retention

Hermes bot containers start the gateway before attempting session retention. Retention runs in the background only after the gateway `/health` endpoint responds; it does not delay gateway startup. If the gateway does not become healthy within `MYRMIDON_BOTD_SESSION_HEALTH_WAIT_SEC` (default 180 seconds), that startup skips retention.

The task lists session metadata in pages, selects rows with a numeric `last_active` older than `MYRMIDON_BOTD_SESSION_RETENTION_DAYS` (default 30 days), and excludes rows marked `pinned` or `is_active`. For each candidate, its detail is streamed to the archive manifest before the gateway receives `DELETE /api/sessions/{id}`. A failed export prevents deletion; failed list or delete requests are logged and do not stop the gateway. Deletions are sequential, with `MYRMIDON_BOTD_SESSION_DELETE_PAUSE_SEC` (default one second) between attempts. The pass records counts and a timestamp under the Hermes home `.myrmidon` directory.

These settings are bot-container environment variables; see [SETTINGS.md](SETTINGS.md) and [SETTINGS.ru.md](SETTINGS.ru.md). They are not live database maintenance controls. The gateway's active database is never VACUUMed or optimized by this task. Any space-reclamation optimize/VACUUM must be handled externally while the bot container is stopped, with an operator check of available disk space; this document does not claim that such an idle-stop workflow is implemented.

This runtime behavior and CI tests do not establish production rollout acceptance. Verify rollout health, startup time on a large database, and database size/OOM observations separately before marking those operational criteria complete.
