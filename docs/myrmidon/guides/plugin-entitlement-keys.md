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
| GET | `/api/myrmidon/plugin-entitlement/keys` | — | the accepted keys `[{ pluginId, expiresAt, acceptedAt }]` — never the key values |
| POST | `/api/myrmidon/plugin-entitlement/keys` | `{ pluginId, key }` | 201 + the updated list (no key values); a duplicate pluginId replaces its previous key; an invalid token → 400 with a clear message |
| DELETE | `/api/myrmidon/plugin-entitlement/keys/:pluginId` | — | the updated list (no key values); removing an absent id is a no-op |
| GET | `/api/myrmidon/plugin-entitlement/public-key` | — | `{ publicKey, source }` — the effective verification public key and where it comes from (`settings`, `env`, or `none`) |
| PUT | `/api/myrmidon/plugin-entitlement/public-key` | `{ publicKey }` | stores the verification public key in the instance settings; `null` or an empty string clears it |

Every response is a *view* projection (`toPluginEntitlementKeyViews`): the
stored entries carry the raw tokens, but the API never returns them, and the
400 error messages carry only the failure reason — no key material.

## Key format and verification (1.6.3, PLUGIN-ENTITLEMENT A)

An entitlement key is an ed25519-signed token:

```
PEK1.<base64url payload JSON>.<base64url signature>
```

- the payload is `{ pluginId, instanceId, expiresAt }` (strict; all required,
  `expiresAt` is an ISO datetime — "never expires" is not expressible in a
  token);
- the signature is ed25519 over the exact payload segment (the base64url
  string between the `PEK1.` prefix and the last dot);
- the verification public key (PEM, ed25519) is the instance setting
  `instance_settings.general.pluginEntitlementPublicKey`, editable in the UI
  without a restart. `MYRMIDON_PLUGIN_ENTITLEMENT_PUBLIC_KEY` (PEM, or a
  base64 raw 32-byte key) is the forced env fallback that applies only when
  no setting is stored;
- `instanceId` is the board's instance id (`PAPERCLIP_INSTANCE_ID`,
  default `default`): a token issued for another instance is rejected.

Verification runs in two places:

1. **acceptance** — `POST .../keys` verifies the signature, the plugin id,
   the instance id, and the expiry before the key is stored. The stored
   `expiresAt` comes from the signed payload, not from the request body.
2. **activation** — the loader gate re-verifies every stored key on each
   activation pass (the public key can rotate after a key was accepted), so
   a stored key whose signature no longer verifies does not entitle the
   plugin: expiry alone is never the verdict.

The shared contract (`packages/shared/src/myrmidon-plugin-entitlement.ts`)
holds the environment-independent parts: the payload schema, the token
parser, and the view projection. The signature check itself
(`verifyEntitlementToken`) lives server-side in
`server/src/myrmidon/plugin-entitlement/validation.ts`.

Issuing tokens (out of band): generate an ed25519 key pair, keep the private
key, and distribute the public key to instances as their setting. Sign the
base64url payload segment with `node:crypto`'s `sign(null, payload,
privateKey)` (ed25519 pure mode).

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

Cryptographic verification landed (1.6.3, PLUGIN-ENTITLEMENT A): see
"Key format and verification" above. The verifier is ed25519 over the
PEK1 token; the verification public key is the instance setting
`pluginEntitlementPublicKey` (env fallback
`MYRMIDON_PLUGIN_ENTITLEMENT_PUBLIC_KEY` when no setting is stored).

## Example

`packages/plugins/examples/plugin-entitlement-test-example/` — a minimal
manifest with `requiresEntitlement: true`, so the gate and the UI can be
exercised without any real licensed plugin. No real plugin name appears in
the code, tests or docs — only this fixture.

## Tests

- `packages/shared/src/myrmidon-plugin-entitlement.myrmidon.test.ts` — the token wire format (payload/signed segment, malformed and strict-schema payloads rejected), stored-list normalization, key activity, the view projection, the verification-key view contract;
- `server/src/myrmidon/plugin-entitlement/plugin-entitlement.myrmidon.test.ts` — key activity (null expiry, past expiry, exact-id match), fail-closed normalization, activation gate decisions (with signature verification: correct signature passes; foreign signature, expired, wrong instance, wrong plugin fail), store semantics (replace on re-accept, remove, preserve, public-key read with env fallback and source), public-key write/clear, the token parser, the view projection (key values never leave the API), incoming-key checks;
- `ui/src/components/myrmidon/PluginEntitlementSettingsPanel.myrmidon.test.tsx` — list with expiry/badge, empty state, accept through the API, the server's rejection reason shown on a bad key, no API call on empty key, remove through the API, verification-key source shown, verification key saved through the API;
- `packages/shared/src/validators/plugin.test.ts` — the manifest flag is optional, additive and type-checked.
