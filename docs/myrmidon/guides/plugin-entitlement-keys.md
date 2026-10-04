# Plugin entitlement keys

myrmidon(PLUGIN-ENTITLEMENT C): instance-level licensing keys that control
which plugins are activated. A plugin whose manifest sets
`requiresEntitlement: true` stays unactivated — no worker process, no UI
slots, hidden from menus and settings — until the instance admin accepts a
valid entitlement key for its exact plugin id.

## How it works

1. A plugin manifest opts in with `requiresEntitlement: true`.
2. The plugin loader checks the gate on every activation pass: it reads the
   accepted keys from `instance_settings.general.pluginEntitlementKeys` and
   looks for an active (unexpired) key matching the manifest id.
3. No key → the plugin is skipped (not an error; retried next pass). Active
   key → the plugin activates normally.
4. The gate re-reads the settings row on every pass, so accepting or removing
   a key takes effect without a server restart.

## The settings UI

The "Plugin keys" block on the instance settings page:

- an input pair (plugin id + key) and an "Add key" action;
- the list of accepted keys — plugin id, expiry date, expired badge;
- a per-key remove action.

Strings live in the fork localization catalog
(`ui/src/i18n/myrmidon-locales/{en,ru}.json`, namespace `pluginEntitlement`);
Russian carries no English strings.

## The API

Instance admin only (mounted in `server/src/app.ts` under `/api`):

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/myrmidon/plugin-entitlement/keys` | — | the accepted keys `[{ pluginId, key, expiresAt, acceptedAt }]` |
| POST | `/api/myrmidon/plugin-entitlement/keys` | `{ pluginId, key }` | 201 + the updated list; a duplicate pluginId replaces its previous key; invalid input → 400 with a clear message |
| DELETE | `/api/myrmidon/plugin-entitlement/keys/:pluginId` | — | the updated list; removing an absent id is a no-op |

## Storage contract

`packages/shared/src/myrmidon-plugin-entitlement.ts` is the shared contract:

- `pluginEntitlementKeySchema` — `{ pluginId, key, expiresAt: string|Date|null, acceptedAt }`, strict;
- `pluginEntitlementKeysSchema` — an array (max 100);
- `normalizePluginEntitlementKeys` — absent or malformed rows normalize to `[]` (fail closed: corrupt data never silently unlocks a plugin);
- `findActivePluginEntitlementKey` / `isPluginEntitlementKeyActive` — expiry resolution (null = never expires).

The keys survive every vendor write of the `general` row through the
`preservePluginEntitlementKeysGeneralKey` helper (the same pattern the other
myrmidon general keys use).

## Key verification

Cryptographic verification is the ML1/ML2 API dependency (out of scope here).
Until it lands, a syntactically valid key for a known plugin id is accepted;
the UI and storage flow are final and testable independently of the verifier.

## Example

`packages/plugins/examples/plugin-entitlement-test-example/` — a minimal
manifest with `requiresEntitlement: true`, so the gate and the UI can be
exercised without any real licensed plugin. No real plugin name appears in
the code, tests or docs — only this fixture.

## Tests

- `server/src/myrmidon/plugin-entitlement/plugin-entitlement.myrmidon.test.ts` — key activity (null expiry, past expiry, exact-id match), fail-closed normalization, activation gate decisions, store semantics (replace on re-accept, remove, preserve), incoming-key checks;
- `ui/src/components/myrmidon/PluginEntitlementSettingsPanel.myrmidon.test.tsx` — list with expiry/badge, empty state, accept through the API, no API call on empty key, remove through the API;
- `packages/shared/src/validators/plugin.test.ts` — the manifest flag is optional, additive and type-checked.
