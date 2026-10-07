# Tab and home-screen icon (FAVICON)

> Russian version: [favicon.ru.md](favicon.ru.md)

The browser tab and the phone home screen show the Myrmidon ant mark — the
paperclip artwork of the vendor does not ship. This guide lists the shipped
files, where they are referenced, and what guards the set.

## Shipped set

| File | Where it is used |
|---|---|
| `ui/public/favicon.svg` | browser tab (SVG; the bare ant mark on transparent, navy in a light colour scheme, white in a dark one) |
| `ui/public/favicon.ico` (16/32/48 px layers) | browser tab fallback |
| `ui/public/favicon-16x16.png`, `ui/public/favicon-32x32.png` | browser tab (raster) |
| `ui/public/apple-touch-icon.png` (180×180) | iPhone/iPad home screen — the white ant on the navy plate |
| `ui/public/android-chrome-192x192.png`, `ui/public/android-chrome-512x512.png` (plus a maskable 512) | Android / PWA home screen and splash — the same app icon |
| `ui/public/site.webmanifest` | PWA manifest; its `icons` reference the 192/512 files |

`ui/index.html` links the tab icons and the manifest; the server
(`server/src/ui-branding.ts`) appends `?v=<build version>` to every icon and
manifest URL at serve time, so a new build refreshes the browser icon store
without manual cache clearing.

The source of the artwork is the design-system export in
`ui/public/brand/myrmidon/` (v2, owner's export of 28.09.2026). The root-level
icon files are byte-identical copies of the brand files; do not redraw them —
if the mark changes, replace the brand export and re-copy.

## Guard tests

- `ui/src/lib/myrmidon-branding-guard.myrmidon.test.ts` — every shipped icon
  file is byte-identical to its brand counterpart; the page title and the
  manifest say Myrmidon; no paperclip artwork is rendered.
- `ui/src/lib/myrmidon-ant-mark.myrmidon.test.ts` — every SVG that draws the
  ant (logo, loader, favicon, app icon, the server worktree-favicon generator)
  uses the identical path geometry.
- `ui/src/lib/myrmidon-favicon-build.myrmidon.test.ts` — `index.html` links the
  full tab icon set; the manifest carries the 192/512 home-screen icons
  including the maskable 512; a built `ui/dist`, when present, ships the same
  files; no paperclip artwork ships in `ui/public`.

No runtime setting configures the icons; the build version cache-bust is
automatic (stamped from the release tag into the image, see
[../SETTINGS.md](../SETTINGS.md), `PAPERCLIP_BUILD_VERSION`).
