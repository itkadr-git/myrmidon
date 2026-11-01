# OPE-10386 — MEDIA-ACL

| Setting | Release | Default | Description | Invalid/disabled behavior |
| --- | --- | --- | --- | --- |
| `MYRMIDON_BOT_CONTAINER_MEDIA_TOOLS_ENV_ALLOWLIST` | 1.6.6 MEDIA-ACL | empty | Comma-separated agent names permitted to receive the `MEDIA_TOOLS_TOKEN` card secret in their Hermes environment during the media-tools rollout. The default empty list enables no agents. Each entry requires an authorized secret reference; token values are never added to adapter environment variables. Enable agents individually only with explicit operator authorization and confirm their ACL entry before use | Empty — no media token bindings. Remove an agent name to revoke this environment binding |
