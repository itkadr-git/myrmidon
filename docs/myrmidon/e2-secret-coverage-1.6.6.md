# E2 secret coverage matrix 1.6.6 (OPE-8994)

Audit basis: `origin/main` / `2e26be9515f67050289515fb40635991be1a5070`. This is a source-level coverage inventory only; no environment values were read, no production changed, and no project workspace was created.

## Exact E1 scope

`node scripts/check-env-registry.mjs` passes: 891 registry entries, 750 distinct code names, 108 entries classified `secret`, 3 secret-classified dynamic patterns. The checker reports six total dynamic patterns spanning four runtime-built prefixes. E1 JSON's `counts.secret` is 108 entries; because the registry entries are unique names, the deduplicated secret-name set is exactly 108. Three additional secret template rows are tracked separately (not added to that 108):

- `MYRMIDON_MCP_TOKEN_<BOT_NAME>`; per-bot/agent; source `server/src/myrmidon/bot-containers/profile-input.ts` (`BOT_MCP_TOKEN_ENV_PREFIX`).
- `PAPERCLIP_TOOL_OAUTH_<PROVIDER>_CLIENT_SECRET`; instance; source `server/src/services/tool-access.ts` (`oauthEnvName`).
- `MYRMIDON_CLOUD_<ONEDRIVE|GOOGLE_DRIVE|YANDEX_DISK>_CLIENT_SECRET`; instance; source `server/src/myrmidon/cloud-connector/oauth.ts`.

Thus 111 classified secret items when exact names and dynamic templates are enumerated separately. All 108 exact-name rows are represented in the checked-in E1 JSON/CSV/MD. The registry checker validates count and code-name reconciliation, not semantic completeness of classifications or runtime resolution; the audit's explicit stale/unmatched consumers remain verification gaps, not evidence of coverage. No E1 entry or classification was altered.

## Coverage status and finite implementation slices

For all 111 items, current E1 `ui_or_store` / `secret_ref_or_instance_setup` records env-only or a desired secret-ref rather than verified completion. E2 existing store, input/select UI, server-side secret resolution, and scope/RBAC are therefore **not established** by the E1 record. Track exact names using the registry file (including aliases and all consumer/source rows); this matrix avoids copying hundreds of identifiers into a second source of truth. A row is assigned by its consumer path to the exhaustive groups below; entries with multiple consumers belong to every applicable group. Groups are deliberately finite by repository path/prefix, not an open-ended "remaining" bucket.

| Group | Registry rows | Existing coverage evidence | E2 disposition / finite slice |
| --- | --- | --- | --- |
| Provider/runtime credentials | Exact secret rows whose consumer is `packages/adapters/**`, `packages/adapter-utils/**`, `server/src/adapters/**`, or provider/runtime config in `server/src/config.ts`; includes aliases as listed in E1 | No verified shared secret-ref-backed provider settings/UI found in E1; process env consumers remain | Add secret-ref resolution at adapter/runtime configuration boundary; retain documented env override and test precedence. Files: adapter config contracts under `packages/shared`, `server/src/adapters/**`, targeted adapter config consumers. Tests: ref resolves, absent ref, env override priority, redaction. Depends on shared resolution API. |
| Bot/container credentials | Exact rows consumed by `server/src/myrmidon/bot-containers/**`, plus `MYRMIDON_MCP_TOKEN_<BOT_NAME>` | E1 identifies process/agent scope; no verified per-agent secret selection or server RBAC coverage | Add agent-scoped reference input/selection and inject only resolved credentials into container; include migration without logging values. Tests: company/agent scope, access denied, absent secret, override. |
| Tool OAuth credentials | Exact rows consumed by `server/src/services/tool-access.ts`, plus `PAPERCLIP_TOOL_OAUTH_<PROVIDER>_CLIENT_SECRET` | Dynamic name generation is present; no verified ref resolution/RBAC or UI for the generated secret | Extend tool-provider credential settings to store refs; enforce instance scope server-side. Tests: provider names, scope authorization, rotation/revoke, env override. |
| Cloud connector OAuth | Exact rows consumed by `server/src/myrmidon/cloud-connector/**`, including the three-provider client-secret template and aliases | OAuth implementation exists; registry calls for secret-ref; no proven persisted ref/UI coverage | Add per-provider secret-ref input/select; server resolves only after connector/company access check. Tests: each provider, denied scope, missing ref, redaction, override precedence. |
| Secret-provider/store internals and migration | Rows consumed by `server/src/secrets/**`, `packages/db/**`, and related config/bootstrap | AWS Secrets Manager provider exists; that is a backend/provider capability, not proof of UI management, refs for every consumer, or RBAC; do not duplicate it | Reuse existing secret service/store; define scoped reference contract and safe one-time migration path. Tests: resolution authorization, no plaintext API/log/error, rotation/revocation, migration non-disclosure. Depends on data/API contract. |
| Other application consumers | All remaining exact secret rows by their E1 consumer paths, including rows in `server/src/routes/**`, `server/src/services/**`, `server/src/config.ts`, and documentation-only/stale consumers; dynamic templates assigned by their `source` above | E1 includes five explicit audit-only/stale consumer entries in docs; code scan miss is unresolved, not coverage. Existing env consumers must be individually migrated or documented as validated override | Split implementation by concrete consumer paths from E1; for each, replace direct env read with shared server resolver and settings UI entry (or document why not user-manageable). Tests per consumer plus shared resolver/RBAC/redaction/override matrix. No row can be removed as stale without code/audit evidence. |

## Verified existing secret-ref exception

The hindsight plugin has `hindsightApiKeyRef?: string` in `packages/plugins/hindsight-paperclip/src/plugin.ts`; manifest declares the field with `format: "secret-ref"`; runtime calls `ctx.secrets.resolve(config.hindsightApiKeyRef)`; `plugin.test.ts` asserts the manifest format. This is established plugin-level ref support and must not be reimplemented. It is not evidence of provider-settings UI or general E2 consumer coverage. The PR #1584 claim is consistent with this code and test. Review server-side scope enforcement in the shared `ctx.secrets.resolve` implementation as part of the store slice; this plugin test alone does not prove it.

## Required acceptance inventory for implementation

For every row/group above, demonstrate: standard store + input/select UI; server-only reference resolution after scope/RBAC checks; safe migration with no value in output; masked API, logs, and errors; replace/revoke flow; documented emergency env override with an explicit priority test. Cover missing refs and denied access. Never rotate actual credentials in this work. Update this versioned matrix with concrete PR/test evidence as slices land; do not weaken E1 to make counts pass.

## E2.1 shared resolver and disposition of the 23 secret-provider names (OPE-9034)

Contract (code: `server/src/myrmidon/secret-settings/`, tests: `resolver.myrmidon.test.ts`):

- Store: a ref is a row of `company_secret_bindings` (target `system`, id `instance-setting:<name>`, path `ref`) written through `replaceSecretRefsForInstanceTarget`; value resolution goes through the existing secrets service (`resolveSecretValue` with the binding context), so provider, version, status and secret access events are reused. No new table, no plaintext column, no migration of the schema.
- Registry: a setting exists only if a consumer registers it in `registry.ts` with `name`, `envOverride` and the `consumers` allowed to resolve it. Other E2 parts append their rows there.
- Resolution order: consumer in scope (else 403 `setting_consumer_denied`), then the emergency env override (set and non-empty wins, documented and tested), then the bound ref (else 422 `setting_ref_missing`; inactive or deleted secret fails typed). Values are registered for log masking and never appear in API bodies, plans or errors.
- API (instance admin only): `GET /api/instance/secret-settings`, `PUT|DELETE /api/instance/secret-settings/:name/ref` (body is a secret id), `GET /api/instance/secret-settings/migration-plan` (dry run: booleans per name, no values). Mutations write `instance.secret_setting.*` activity.
- UI (slice 2): `InstanceSecretSettingsPanel` in the current UI (Settings, General) and `Ui2InstanceSecretSettings` in UI2 (Settings, System) choose and remove a ref through one hook; both render nothing while the registry is empty. `POST /api/instance/secret-settings/migrate` is a dry run unless the body says `"apply": true` (then it needs `companyId`, creates a managed secret per env-held setting, binds it, leaves the env variable in place, returns ids only).
- Resolution goes through the secrets service with the binding context because `ctx.secrets.resolve` is the plugin-worker context (plugin-host-services, capability `secrets.resolve`); the core server has no such ctx on this path.
- Not in this slice: the consumers of the other E2 groups; they build on this contract.

Disposition of the exact E1 names of this part (the source lines are those listed in the ticket):

| Names | Disposition | Reason / evidence |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | bootstrap, env-only | Credentials the AWS provider uses to open the store; `aws-secrets-manager-provider.ts:361` only detects that both are present (the SDK reads them). A store cannot hold the key that opens it. Guarded by the registry test. |
| `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`, `AWS_PROFILE`, `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `AWS_CONTAINER_CREDENTIALS_FULL_URI` | bootstrap, env-only (paths / identifiers of the SDK credential chain, not values) | Lines 360-373 only record which credential source is configured. Same circularity; same guard. |
| `MYRMIDON_SECRETS_MASTER_KEY`, `MYRMIDON_SECRETS_MASTER_KEY_FILE` | bootstrap, env or file only | Master key of the local encrypted provider cannot be encrypted by itself. Already masked in logs (`secret-masking.ts:31`); the file form is the preferred one. |
| `MYRMIDON_SECRETS_PROVIDER`, `MYRMIDON_SECRETS_STRICT_MODE` | non-secret selector | Choose provider and strictness (`config.ts:143`, `config.ts:185`). |
| `AWS_REGION`, `AWS_DEFAULT_REGION`, `MYRMIDON_SECRETS_AWS_REGION`, `MYRMIDON_SECRETS_AWS_ENDPOINT`, `MYRMIDON_SECRETS_AWS_PREFIX`, `MYRMIDON_SECRETS_AWS_ENVIRONMENT`, `MYRMIDON_SECRETS_AWS_PROVIDER_OWNER`, `MYRMIDON_SECRETS_AWS_DEPLOYMENT_ID`, `MYRMIDON_SECRETS_AWS_KMS_KEY_ID`, `MYRMIDON_SECRETS_AWS_DELETE_RECOVERY_DAYS` | non-secret configuration | Region, endpoint, naming prefix, tags, key identifier and a day count (`aws-secrets-manager-provider.ts:299-430`). Identifiers and limits, not credentials; per-company values already live in provider configs. Not classified as secret automatically and not moved. |

The E1 `secret` classification of the bootstrap rows stays as the registry has it (the matrix does not alter E1); their accepted disposition is "bootstrap, no ref", with the threat model above.

