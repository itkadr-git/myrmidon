# Licensing of closed modules

> Russian version: [licensing.ru.md](licensing.ru.md)

The closed connector modules (`google-ai`, `antigravity`, `chatgpt-pool`) start
only with a valid license. The board gives the installation owner two things:
the installation id with a one-click license request, and a form that signs a
license. Both live in **Settings → Instance → General → Licensing** and are
visible to instance admins only (every `/api/licensing/*` route answers 403 to
anyone else).

## Installation id

The id is `myr-` plus the first 20 hex characters of `sha256(machine-id)`
(`/etc/machine-id`, then `/var/lib/dbus/machine-id`). It is the same algorithm
the modules run, so a license signed for the id shown by the board is accepted
by the modules **only if the board and the modules see the same machine id**.
In containers mount the host file read-only (`/etc/machine-id:/etc/machine-id:ro`)
or set the same `MYR_LICENSE_INSTANCE_ID` for the board and the modules. When no
machine id exists the id is generated once and cached in
`MYR_LICENSE_STATE_DIR` (default `~/.local/state/myrmidon-license`); the screen
then shows a warning, because a new install gets a new id.

`GET /api/licensing/install-id` returns `{ "installId": "myr-…", "source": "machine-id" | "env" | "generated" }`.

## Request a license (client side)

1. Open the Licensing section, tick the modules you need.
2. Press **Copy license request**. The text is one line, `MYRQ1.<base64url(json)>`
   with `{v, instance_id, board, modules, ts}`.
3. Send it to the owner in any messenger. The request is not signed: it is a
   convenience, not authentication — the owner confirms who the client is.

## Issue a license (owner side)

1. Configure the signing key on the server (below).
2. In the Licensing section paste the request into **License request from the
   client** (the installation id and modules are filled in), or type the id by
   hand.
3. Tick modules, set the term in days (or **No expiry**), put the client name
   into **Client / watermark**, press **Issue license**.
4. Copy the text or download `license.key` and place it where the modules on that
   installation read their license.

The result is the module license format `MYR1.<payload>.<signature>`: canonical
JSON payload `{rev, instance_id, modules, features, expires, watermark}` signed
with Ed25519 over the raw payload bytes. `features` always contains `core`.
Every issue is appended to a journal (who, when, installation id, modules,
expiry, watermark — never the license text), shown in **Issued licenses**.
Revocation is not instant: the modules work offline, so a license ends by
expiry or by not being renewed.

## Server settings

| Variable | Meaning |
|---|---|
| `MYRMIDON_LICENSE_ISSUER_KEY_FILE` | Path to the Ed25519 **private** key in PEM (PKCS#8) readable by the board process. Not set — the form says the key is not configured and issuing is refused (409). The key is read per issue; it is never returned by the API or logged. |
| `MYRMIDON_LICENSE_JOURNAL_FILE` | Journal of issued licenses (JSON lines). Default: `<instance root>/data/licensing/issued.jsonl`. Keep it on a persistent volume. |
| `MYR_LICENSE_INSTANCE_ID` | Optional explicit override of the installation id; must be the same for the board and the modules. |
| `MYR_LICENSE_STATE_DIR` | Cache directory for the generated id when no machine id exists. |

Generate a key pair once, keep the private key outside the repository, give the
board a read-only file, and embed the public key in the module build:

```sh
openssl genpkey -algorithm ed25519 -out /path/to/issuer-ed25519.key.pem
openssl pkey -in /path/to/issuer-ed25519.key.pem -pubout
chmod 0400 /path/to/issuer-ed25519.key.pem
```

## Notes

- The MYRQ1 `instance_id` is the module id (`myr-…`), not a raw sha256 hex: the
  license must carry exactly the string the modules compare against.
- The `py` field of the request is optional and not produced by the board.
