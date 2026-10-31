# Standby readiness checklist

Run `infra/standby-readiness.sh` on a candidate standby host. The script is read-only, prints one `[PASS]` or `[FAIL]` line per prerequisite, and exits non-zero if any check fails.

Defaults require Linux major version 22+, Docker server 24+, PostgreSQL client 14+, reachable PostgreSQL at `127.0.0.1:5432`, and reachable LiteLLM at `127.0.0.1:4000`. These are minimum compatibility defaults; override them for the target deployment with `OS_MIN_MAJOR`, `DOCKER_MIN_MAJOR`, `POSTGRES_MIN_MAJOR`, `POSTGRES_HOST`, `POSTGRES_PORT`, `LITELLM_HOST`, and `LITELLM_PORT`.

The secret check only verifies presence, not values. Set the required variable names in `REQUIRED_SECRETS` (comma-separated; defaults: `DATABASE_URL,LITELLM_MASTER_KEY,LITELLM_API_KEY`) and export those variables without printing them. Point `LITELLM_MIRROR_CONFIG` to the mirror's configuration file; it must contain a `mirror`, `api_base`, or `base_url` setting. No credentials or secret values are emitted.

Example: `REQUIRED_SECRETS=DATABASE_URL,LITELLM_MASTER_KEY,LITELLM_API_KEY LITELLM_MIRROR_CONFIG=/etc/litellm/config.yaml infra/standby-readiness.sh`
