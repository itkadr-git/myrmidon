# Licenses of the redistributable image dependencies

> Русская версия: [licenses.ru.md](licenses.ru.md)

Status: research note for the maintainer. Facts collected 2026-10-25 from
`pnpm-lock.yaml` and `Dockerfile` on `main` (`a110c35de`),
the npm tarballs of the exact pinned versions, and the public license texts.
No code changed; the composition of the image is the maintainer's decision.
This is an engineering assessment of license risk, **not legal advice** and not
a legal permission to distribute.

## Context

Myrmidon is an MIT product shipped as a Docker image (multi-stage `Dockerfile`,
`production` target: `pnpm install --frozen-lockfile` → build → runtime). The
publish-relevant dependencies sit in the exceptions of
[`scripts/myrmidon/license-policy.json`](../../scripts/myrmidon/license-policy.json)
marked "flagged for maintainer review":

| Package | Version | License | Where it enters the image |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` (+ `-linux-x64`, `-linux-x64-musl` in the image) | 0.3.263 | proprietary (Anthropic) | `pnpm-lock.yaml` prod deps of `@agentclientprotocol/claude-agent-acp` |
| `@cursor/sdk` (+ `@cursor/sdk-linux-x64` in the image) | 1.0.28 | proprietary (Anysphere) | `pnpm-lock.yaml` prod deps of `packages/adapters/cursor-cloud` |
| `@img/sharp-libvips-linux-x64`, `@img/sharp-libvips-linuxmusl-x64` | 1.3.3 | LGPL-3.0-or-later | optional platform deps of `sharp` (prod) |
| `@anthropic-ai/claude-code` | 2.1.283 | proprietary (Anthropic) | `npm install --global` in the `Dockerfile` (`ARG CLAUDE_CODE_VERSION`), outside `pnpm-lock.yaml` and outside `license-policy.json` |

The image builds for `linux/amd64`, so the `linux-x64` (glibc) platform
packages are the ones actually present; other platform packages stay in the
lockfile only.

Three risk groups: proprietary SDKs under non-OSSI terms ("All rights
reserved"), weak LGPL-3.0 copyleft inside a redistributable image, and the
size of the platform binaries.

## What the primary texts say

### 1. `@anthropic-ai/claude-agent-sdk` 0.3.263

- Tarball `package.json`: `"license": "SEE LICENSE IN README.md"`. The README
  of the SDK points to the commercial legal agreements; there is no open-source
  license grant in the tarball.
- Tarball `LICENSE.md` (verbatim): "© Anthropic PBC. All rights reserved. Use
  is subject to the Legal Agreements outlined here:
  https://code.claude.com/docs/en/legal-and-compliance".
- The referenced agreements (Anthropic Commercial Terms,
  https://www.anthropic.com/legal/commercial-terms) grant *use* — A.1
  "permission to use the Services, including to power products and services
  Customer makes available to its own customers and end users" — so an operator
  deploying the image and running agents through the SDK is covered for use.
- They do **not** grant redistribution: F reads "these Terms do not grant
  either party any rights to the other's content or intellectual property";
  D.4 forbids reverse engineering and duplicating the Services. There is no
  clause permitting copying or distributing the SDK binaries.

Conclusion: **redistribution of the SDK inside a published MIT image is not
licensed by the primary texts.** "Redistributed unmodified in the image" (the
wording of the current `license-policy.json` exception) does not change that:
the texts contain no grant it could rely on. Whether Anthropic would tolerate
it in practice is a question only the maintainer (or Anthropic) can answer.

Sources: `package.json` and `LICENSE.md` of the
`@anthropic-ai/claude-agent-sdk@0.3.263` tarball (npm, anonymous download);
https://code.claude.com/docs/en/legal-and-compliance;
https://www.anthropic.com/legal/commercial-terms (A.1, D.4, F).

### 2. `@cursor/sdk` 1.0.28

- Tarball `package.json`: `"license": "SEE LICENSE IN LICENSE.md"`.
- Tarball `LICENSE.md` (verbatim): "Cursor SDK License — © Anysphere Inc. All
  rights reserved. Use is subject to Cursor's Terms of Service
  (https://cursor.com/terms-of-service)."
- The ToS grant a "limited right to access and use the Service" (1.1) — use,
  not redistribution.
- ToS 1.5 (iii) forbids to "rent, lease, lend, or sell the Service"; 1.5 (ii)
  forbids to "reproduce, modify, translate, or create derivative works of the
  Service". Copying the SDK package into a distributed image is a reproduction
  of copyrighted material; no clause permits it. If "the Service" is read
  narrowly (the hosted service only) the SDK binaries fall back to plain "All
  rights reserved" — either way there is no distribution grant.
- The SDK is used by the `cursor-cloud` adapter and requires Cursor
  credentials; the package also pulls `@cursor/sdk-linux-x64` (optional
  platform binary).

Conclusion: **redistribution in a published image conflicts with the Cursor
ToS (reproduce / sell / rent / lease) or, under the narrow reading, is simply
unlicensed.** Either way, no permission exists in the primary texts.

Sources: `package.json` and `LICENSE.md` of the `@cursor/sdk@1.0.28` tarball
(npm, anonymous download); https://cursor.com/terms-of-service (1.1, 1.5).

### 3. `@img/sharp-libvips-*` 1.3.3 (LGPL-3.0-or-later)

- Tarball `package.json`: `"license": "LGPL-3.0-or-later"`; the package ships
  prebuilt shared libraries (`libvips-cpp.so.8.18.6` and dependencies,
  versions listed in `versions.json`, e.g. glib 2.89.4, pango 1.58.2).
- LGPL-3.0 §4 (Combined Works) permits distributing a combined work containing
  the library, provided the library itself remains LGPL and modifiable by the
  user: convey the license and copyright of the library, point to the source,
  and allow the user to replace the library with a modified version. sharp
  (Apache-2.0) loads the prebuilt `.so` dynamically; Myrmidon modifies neither
  sharp nor libvips.

Conclusion: **permitted to redistribute inside the image, with obligations.**
LGPL does not forbid distribution and is compatible with the MIT license of
the product; the obligations are (a) a notice carrying the license and
copyright of libvips and the bundled libraries (the package README lists them,
including several bundled under LGPLv3: fribidi, glib, libexif, libheif,
librsvg, pango, proxy-libintl), and (b) a way for the recipient to obtain the
corresponding source — a link to the exact upstream source
(https://github.com/lovell/sharp-libvips, tag/version 1.3.3) together with the
written-offer alternative of LGPL §6(d) (offer valid ≥ 3 years) is the
practical path. None of this requires disclosing Myrmidon's own source.

Sources: `package.json`, `versions.json` and `README` of the
`@img/sharp-libvips-linux-x64@1.3.3` tarball (npm, anonymous download);
https://www.gnu.org/licenses/lgpl-3.0.html (§4, §6).

### 4. `@anthropic-ai/claude-code` 2.1.283 (global npm install in the image)

- Installed globally in the runtime image by the `Dockerfile`
  (`ARG CLAUDE_CODE_VERSION=2.1.283`, `npm install --global --omit=dev`), so it
  ships in every published image but never appears in `pnpm licenses list
  --prod` and is absent from `license-policy.json` — a blind spot of the CI
  license check.
- Tarball `LICENSE.md` is identical in kind to the agent SDK: "© Anthropic PBC.
  All rights reserved. Use is subject to the Legal Agreements outlined here:
  https://code.claude.com/docs/en/legal-and-compliance";
  `package.json`: `"license": "SEE LICENSE IN README.md"`.

Conclusion: same proprietary class as `@anthropic-ai/claude-agent-sdk`; no
distribution grant in the primary texts. Any decision about the SDK applies to
it as well.

Sources: `package.json` and `LICENSE.md` of the
`@anthropic-ai/claude-code@2.1.283` tarball (npm, anonymous download).

## Options

A. Keep all four in the image as is.
   - Pros: works out of the box (claude_local via the SDK, cursor-cloud, fast
     image processing, Claude Code CLI available to agents).
   - Cons: proprietary binaries inside a published MIT image — a legal risk the
     maintainer owns; the Cursor ToS name sell/rent/lease/reproduce directly;
     the image grows by the platform binaries.

B. Move the proprietary SDKs out of the base image into an opt-in target/plugin
   (extra Docker target, plugin, or a documented `pnpm add`/`npm i -g` by the
   user); keep sharp/libvips with an LGPL notice.
   - Pros: the base image is MIT + permissive mass only; the Anthropic/Cursor
     terms bind the user who installs the SDK under their own account; the
     direct ToS conflict disappears.
   - Cons: needs a Dockerfile mechanism plus documentation; claude_local and
     cursor-cloud do not work until the user opts in; `@anthropic-ai/claude-code`
     (global install) needs the same treatment or a conscious decision to keep.

C. Do not ship any proprietary SDK; keep sharp/libvips with a notice.
   - Cleanest legally; everything OSI-licensed; users install SDKs/CLIs at
     runtime under their own credentials. Same cost as B plus losing the
     preinstalled Claude Code CLI.

## Recommendation

**B.** Move `@anthropic-ai/claude-agent-sdk` (with its platform packages) and
`@cursor/sdk` (with `@cursor/sdk-linux-x64`) out of the base image into an
opt-in target/plugin, and treat `@anthropic-ai/claude-code` in the same
decision (either move it too, or keep it consciously with a notice). Keep
`@img/sharp-libvips-*` and ship a third-party notice for it (license,
copyright, source link — LGPL §4). This removes the only direct ToS conflict
(Cursor) and the missing-grant uncertainty (Anthropic) while keeping the
legal self-service path for users who need those adapters.

If the maintainer chooses A, the minimum obligations are: a third-party notice
in the image and/or repository covering all four packages (© Anthropic PBC —
Commercial Terms URL; © Anysphere Inc. — ToS URL; libvips LGPL-3.0-or-later
with source link), and an explicit acceptance that the Anthropic/Cursor texts
give no redistribution grant.

The decision belongs to the maintainer; this note changes no policy. The
exceptions in `scripts/myrmidon/license-policy.json` stay as they are until
the maintainer decides.

## Sources

- `pnpm-lock.yaml` on `main` `a110c35de`: `@anthropic-ai/claude-agent-sdk@0.3.263`
  (prod via `@agentclientprotocol/claude-agent-acp`), `@cursor/sdk@1.0.28` (prod
  via `packages/adapters/cursor-cloud`), `@img/sharp-libvips-*@1.3.3` (optional
  platform deps of `sharp`).
- `Dockerfile` on `main` `a110c35de`: `ARG CLAUDE_CODE_VERSION=2.1.283`,
  `npm install --global --omit=dev @anthropic-ai/claude-code@…`.
- npm tarballs (registry.npmjs.org, anonymous): `package.json` / `LICENSE.md` /
  `README` of `@anthropic-ai/claude-agent-sdk@0.3.263`, `@cursor/sdk@1.0.28`,
  `@img/sharp-libvips-linux-x64@1.3.3`, `@anthropic-ai/claude-code@2.1.283`.
- https://www.anthropic.com/legal/commercial-terms (A.1, D.4, F).
- https://cursor.com/terms-of-service (1.1, 1.5).
- https://code.claude.com/docs/en/legal-and-compliance.
- https://www.gnu.org/licenses/lgpl-3.0.html (§4 Combined Works, §6).
- `scripts/myrmidon/license-policy.json` (current exceptions and their "flagged
  for maintainer review" notes).
