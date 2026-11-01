# The vendor name in the build (REBRAND F)

> Russian version: [rebrand-vendor-name.ru.md](rebrand-vendor-name.ru.md)

The product rule of the 1.7 rebrand: the vendor's name stays only in the
`LICENSE`, in the third-party notices and in the "based on … (MIT)" line of the
About surface. Everything a person reads in the interface and everything the
server answers says **Myrmidon**.

This guide describes the gate that keeps it that way. It reads the *built*
interface and the *recorded server answers*, so a vendor name that only appears
after a build — in a bundled string, in a minified constant, in the response of
an endpoint — is caught as well, not only a mention in the source.

## Where the name may stay

| Surface | Why |
|---|---|
| `LICENSE`, `NOTICE`, third-party notices | The MIT licence requires the original copyright and permission notice |
| The "based on … (MIT)" line of About | The attribution the licence asks for, shown where a person can find it |
| `X-Paperclip-*` headers, `PAPERCLIP_*` variables, `@paperclipai/*` packages, API paths, storage keys | Wire and storage identifiers, not visible copy. They stay for one release as aliases, so installed systems and agent skills keep working (see [CONVENTIONS.md](../CONVENTIONS.md), §8) |
| `Paperclip Cloud`, `Paperclip Labs`, `Paperclip EE`, `Paperclip Enterprise` | The vendor's real external services: renaming them would name something that does not exist |
| The legacy "Paperclip …" recovery-notice sentences | Comments stored before the rename still carry them, and the interface recognises those notices by their exact text |
| The name of a part of our product | No exception: "Myrmidon Runner", "Myrmidon Computer", "Myrmidon-managed" |

The exception list of the gate mirrors the allowlist of the source-side guard
`ui/src/lib/myrmidon-branding-guard.myrmidon.test.ts` (B1a). A new vendor
mention that is not on either list is a leak.

## What the gate reads

Two targets:

- **bundle** — the built UI (`ui/dist`): the exact text a browser receives.
- **snapshots** — the recorded response bodies of the main endpoints
  (`scripts/myrmidon/vendor-name/snapshots`):
  - `GET /` — the branded `index.html`;
  - `GET /site.webmanifest` — the name a home-screen icon gets;
  - `GET /api/openapi.json` — the API document: its title and description and
    the summary, description and field text of every operation. The snapshot
    keeps that text (deduplicated and sorted), not the megabytes of generated
    structure around it.

Both targets are counted in two classes, because the rebrand keeps the vendor's
name as an identifier on purpose:

- **visible** — the capitalised vendor word (`\bPaperclip\b`): what a person
  reads. This is the class the gate acts on.
- **identifier** — every other spelling (`paperclip`): `@paperclipai/*`,
  `PAPERCLIP_*`, `/api/paperclip/…`, storage keys. Reported in the output,
  never gated: those are the aliases that must keep working for one release.

## Modes

| Mode | The gate fails when | When |
|---|---|---|
| `ratchet` (default) | the visible count of a target **grows above the baseline** recorded in the policy file | now: the visible strings of REBRAND A (interface) and REBRAND B (server texts) are still on their way in |
| `strict` | any visible occurrence is left outside the exceptions | after REBRAND A and REBRAND B have merged: the built interface and the server answers then carry only the exceptions above |

The mode is resolved in this order:

1. `--mode ratchet|strict` on the command line;
2. `MYRMIDON_VENDOR_NAME_CHECK_MODE` — a forced override for one run or one
   deployment;
3. the `mode` field of the policy file — the repository default, and what CI
   uses.

Switching to `strict` is a two-line change in the same PR: set `"mode": "strict"`
in the policy file and lower the two baselines to the number of exception
occurrences that stay. Never raise a baseline to make CI pass — remove the
occurrence, or add a reasoned exception.

## Running it

```sh
# both targets, locally (the UI has to be built first)
pnpm --filter @paperclipai/ui build
node scripts/myrmidon/vendor-name/check-vendor-name.mjs

# one target, with a machine-readable report
node scripts/myrmidon/vendor-name/check-vendor-name.mjs --target bundle --json /tmp/vendor-name.json

# the build lane of CI does exactly this, with freshly captured snapshots:
pnpm --filter @paperclipai/server exec tsx \
  ../scripts/myrmidon/vendor-name/capture-snapshots.ts --out "$RUNNER_TEMP/vendor-name-snapshots"
node scripts/myrmidon/vendor-name/check-vendor-name.mjs --target snapshots \
  --snapshots "$RUNNER_TEMP/vendor-name-snapshots"
node scripts/myrmidon/vendor-name/check-vendor-name.mjs --target bundle
```

Exit codes: `0` pass, `1` the vendor name is over its allowance, `2` usage or
read error (an unreadable policy, or a target directory that is not there, is
never reported as clean).

## Refreshing the snapshots

The recorded response bodies are produced by the server's own functions — the
same ones that serve the endpoints — so the snapshot is the real body and not a
copy of it:

```sh
pnpm --filter @paperclipai/server exec tsx \
  ../scripts/myrmidon/vendor-name/capture-snapshots.ts
```

The capture is deterministic (sorted keys, no timestamps, no release version).
It refuses to write a body that matches a secret or an internal address, so a
committed snapshot stays publishable. Refresh it in the same PR as the change
that made it stale; CI captures its own copy fresh in the build lane, so the
gate never depends on the committed set being up to date.

## The baseline

The `targets.<name>.baseline` field counts the visible occurrences recorded the
last time the file was refreshed. In `ratchet` mode the gate is
`count <= baseline`; `--baseline <n>` overrides both targets for one run (useful
when lowering the ratchet before the baseline file is updated).

## Policy file

`scripts/myrmidon/vendor-name/vendor-name-policy.json` owns the whole rule: the
two token patterns, the mode, the baselines, the file-level exceptions
(`LICENSE`, notices, source maps) and the span-level exceptions (the
attribution, the external services, the header names, the legacy notice
sentences). The policy is the single source of truth: the same file is read by
CI, by a developer run and by the instance settings panel.

A change under `scripts/myrmidon/vendor-name/` forces the full CI tier
(`scripts/myrmidon/ci/select.mjs`), so the gate itself always runs on a change
to its own rule.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `MYRMIDON_VENDOR_NAME_CHECK_MODE` | unset — the policy file decides | Forced override of the mode. The normal way to change it is the instance setting below |
| `MYRMIDON_VENDOR_NAME_CHECK_BASELINE` | unset — the policy file decides | Forced override of the baseline. `--baseline` on the script wins over the variable, the variable over the policy file |

A value that does not parse is not an override: `MYRMIDON_VENDOR_NAME_CHECK_MODE=maybe`
is ignored, the panel keeps reporting "Saved here" or "Default", and only a
`ratchet`/`strict` value is ever shown as forced.

The instance setting lives under `instance_settings.general.vendorNameCheck`
(`{ mode, baseline }`), is read by `GET /api/myrmidon/vendor-name-check` and
written by `PATCH` on the same path (instance-admin only), and is edited on
**Instance → General → "Vendor name in the build"**. The panel shows, per field,
where the effective value comes from (saved here / environment override /
default) and reports the gate's own answer about this build — the visible and
identifier counts of every target with its baseline, and the files that carry a
mention — so an operator sees what the gate would say about the installation.
The read runs the same repository script CI runs; a published image has no
repository next to it, and the panel then says so instead of inventing a count.
"Check the build again" re-reads without a restart, and saving never bakes an
active environment override into the database: the patch is merged onto the
stored value, so the override can be removed later without a leftover choice.

Like the other instance settings it applies without a restart.

## Tests

```sh
node --test scripts/myrmidon/vendor-name/check-vendor-name.test.mjs
node --test scripts/myrmidon/ci/select.test.mjs
pnpm --filter @paperclipai/shared exec vitest run src/myrmidon-vendor-name.test.ts
pnpm --filter @paperclipai/server exec vitest run src/myrmidon/vendor-name
pnpm --filter @paperclipai/ui exec vitest run src/components/myrmidon/VendorNameCheckSettingsPanel.myrmidon.test.tsx
```

The first suite carries the acceptance criterion of the gate: one added line
with the vendor's name in the built interface — or in a recorded response —
drops the check.