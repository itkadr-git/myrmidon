# Licensing of closed modules

> Русская версия: [licensing.ru.md](licensing.ru.md)

The closed connector modules (`google-ai`, `antigravity`, `chatgpt-pool`) run
only with a valid license. A license is one line `MYR1.…` (the file
`license.key`) bound to the installation id; one file covers every purchased
module. Requesting and installing a license happens on **Settings → Instance →
Licenses**. The screen and every `/api/licensing/*` route are for the instance
admin only.

## Getting a license

1. Open **Licenses**. At the top is the installation id (`myr-` and 20 hex
   characters of the host's `sha256(machine-id)`).
2. Under **Request a license** the closed modules installed into this board are
   already ticked; add or remove modules as needed.
3. Press **Copy request** and send the `MYRQ1.…` line to the vendor in one
   message. The request is not signed and holds nothing confidential — only the
   installation id, the board version, the modules and the time.

## Installing a license

1. Get `license.key` (or the `MYR1.…` line) from the vendor.
2. Under **Install a license** paste the line, or press **Load license.key
   file**, then **Save license**.
3. The board verifies the license with the same algorithm and the same public
   key as the modules. A license for another installation, an expired one, one
   with a bad signature or something that is not a license is not saved and
   the reason is shown; the current file stays as it was.
4. A saved license is written to the file the modules read. The modules re-read
   it on every check — no restart needed.

**License state** shows for each module: "Valid until …", "Expires …" (less
than 14 days left), "Expired", "Not for this installation", "Not included in
the license", "No license", "Invalid signature" — the module's own decision on
the same file by the same rules. While an installed module has no valid
license, the admin sees a banner linking to the screen.

## Where the license lives (one file per host)

Modules on one host run in different places but read one path — `MYR_LICENSE`,
else the file `MYR_LICENSE_PATH`, default `/etc/myrmidon-license/license.key`:

| Where the module runs | How it sees the file |
|---|---|
| host processes (`chatgpt-pool`, the `google-ai` pool) | `/etc/myrmidon-license/license.key` directly |
| module containers (`google-ai` bridges and MCP) | the host file mounted read-only |
| the `antigravity` adapter — inside the board container | the host directory mounted into the board |

So the single storage place is the host directory `/etc/myrmidon-license`; the
board mounts it **read-write** at the same path and gets
`MYR_LICENSE_PATH=/etc/myrmidon-license/license.key`. The screen writes that
file and all three kinds of modules see it; there is no second copy. The file
is rewritten in place (same inode), so containers that mounted the single file
see the new license without being recreated.

The installer (`scripts/myrmidon/install/install.sh`) does this: it creates
the directory, hands it to the board user (uid `1000`) and adds to the
`server` service of `compose.yml`:

```yaml
    environment:
      MYR_LICENSE_PATH: "/etc/myrmidon-license/license.key"
    volumes:
      - ${MYRMIDON_LICENSE_DIR:-/etc/myrmidon-license}:/etc/myrmidon-license
      - /etc/machine-id:/etc/machine-id:ro
```

For a hand-built installation do the same:

```sh
install -d -m 0755 -o 1000 -g 1000 /etc/myrmidon-license
# hand an existing license file to the board:
chown 1000:1000 /etc/myrmidon-license/license.key && chmod 0644 /etc/myrmidon-license/license.key
```

and add the lines above to the board's compose. Mounting only the file
`license.key:...:ro` into the board does not work: the screen could not save a
license. When the directory is not mounted the screen warns, and saving answers
with a clear error naming the path.

## Installation id

The board owns the id, and there is exactly one. It is stored in the board
database on the first start and never changes afterwards: not with the machine
id, not with `MYR_LICENSE_INSTANCE_ID`, not with a re-created container. On the
first start the id is `MYR_LICENSE_INSTANCE_ID` if set, else `myr-` + 20 hex of
`sha256(machine-id)` (the formula earlier boards used, so licenses already
issued stay valid), else `myr-` + 20 hex of a random UUID. The Licenses screen,
`GET /api/licensing/install-id` and the license check all read it from the
database.

At start the board writes the id to the file `instance-id` in the license
directory (`dirname(MYR_LICENSE_PATH)`, default `/etc/myrmidon-license`;
atomic, mode 0644). The modules read that file, so the directory must be
mounted into the board read-write. If it is not writable the board logs a
warning and starts, but the modules cannot learn the id.

A license issued for another installation is reported with both ids: the one
the license was issued for and the id of this board.

## When the license comes from a variable

If the board has `MYR_LICENSE` (the license text in the environment), it
overrides the file for the adapter inside the board too. The screen then shows
that license's state but does not offer saving: remove the variable to use the
file.

## Vendor key rotation

The board trusts only the public keys built into it
(`server/src/myrmidon/licensing/trusted-keys.ts`) — the same ones built into the
modules. A license without a `kid` field is checked against every trusted key;
one with `kid` only against the key of that `kid`. A new key is added with its
`kid`; the old one stays while licenses it signed are in use.

## Reference: API

| Route | What it does |
|---|---|
| `GET /api/licensing/install-id` | `{ installId, source }` |
| `GET /api/licensing/status[?modules=a,b]` | id, `MYRQ1` request, installed modules, license state per module, file path; the license text is never returned |
| `POST /api/licensing/license` `{ "value": "MYR1.…" }` | verify and save the license; `422` with code `license_<reason>`, `409` `license_path_unwritable` / `license_env_override` |

Issuing licenses is the vendor's side and is not on this screen.
