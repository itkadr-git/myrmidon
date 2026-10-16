# Product name in the docs

> Russian version: [docs-branding.ru.md](docs-branding.ru.md)

The product is called **Myrmidon** in the user and operator documentation under
`docs/`. The vendor name **Paperclip** stays only where the license and the
provenance of the codebase require it: `LICENSE`, the third-party notices
(`NOTICE`, `ui/public/fonts/NOTICE.md`, …), and the attribution line
"Based on Paperclip (MIT)" on the About screen and in the exported README.

## What was renamed (REBRAND E, 1.7)

Every prose mention of the product in `docs/**` now says Myrmidon — guides,
API docs, deployment docs, specs, and the docs-site manifest (`docs/docs.json`,
whose site name is now "Myrmidon"). The start page `docs/start/what-is-paperclip.md`
keeps its file name for link compatibility; its content and its title in the
docs-site navigation say Myrmidon.

## What stays Paperclip, on purpose

These identifiers are not renamed, because renaming them would break installed
systems, agent skills, or the vendor-merge workflow. They are allowlisted in
`scripts/myrmidon/docs-branding-guard.mjs` and stay until the epics that own
them rename the code side first:

- npm packages `@paperclipai/*` and the `paperclipai` CLI (`npx paperclipai …`).
- Environment variables `PAPERCLIP_*`, HTTP headers `X-Paperclip-*`, and the
  vendor repo URLs `github.com/paperclipai/paperclip`.
- The internal skill path `skills/paperclip/` and agent skill names such as
  `paperclip-create-agent`, `paperclip-operations`, `hindsight-paperclip`.
- Runtime/container identifiers in operator examples: the `paperclip`
  systemd unit, Docker image/container names (`paperclip`, `paperclip-local`,
  `paperclip-db`, `paperclip-server`), AWS example resource names in
  `docs/deploy/aws-ecs.md` (`paperclip-ecs`, `paperclip-alb`, `paperclip-rds`,
  `paperclip-efs`, …), the default database name and
  `DATABASE_APPLICATION_NAME=paperclip`, and data paths (`~/.paperclip/…`,
  `docker-paperclip`, `paperclip-ext/…`).
- Wire-format identifiers in `docs/specs/external-task-protocol.md`
  (`originSide=paperclip`, `paperclipValue`, `lastPaperclipFingerprint`,
  `paperclipUrl`, …) and config keys such as `paperclip.adapterUiParser`,
  `paperclip.manifest.json`, and the stack-registry seed component `paperclip`.
- Third-party product names: **Paperclip Cloud**, **Paperclip Labs**,
  **Paperclip EE**, **Paperclip Enterprise** — external vendor services, not
  our product.
- Historical records: `docs/myrmidon/CHANGELOG{,.ru}.md` and the
  `docs/myrmidon/tracks/*.md` logs describe past states and keep the names
  that were correct at the time (e.g. the pre-rename `paperclip:2026.916.1`
  image tag, legacy notification texts the server still recognizes).

## Compatibility

Old names keep working as aliases for one release (1.7): the server recognizes
pre-rename notification bodies, the docs page file names are unchanged, and no
URL or identifier an agent or an installation depends on was renamed. The
aliases are removed no earlier than 1.8.

## Checking

`node scripts/myrmidon/docs-branding-guard.mjs` fails CI when a new
non-allowlisted vendor-name mention appears in `docs/`. When a later epic
renames an identifier (packages, env vars, API paths), remove the matching
entry from the allowlist and update the docs in the same PR.

When you add a new doc that mentions a kept identifier in a new wording, extend
the allowlist in `scripts/myrmidon/docs-branding-guard.mjs` and record the
change in `docs/myrmidon/DIVERGENCE.md`.
