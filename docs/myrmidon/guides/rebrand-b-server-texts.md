# Rebrand B: server texts, installer, CLI output, API messages

This guide documents the 1.7 REBRAND B pass (issue OPE-4155): user-visible text
in the server and the CLI names the product **Myrmidon**. The vendor name
remains only in the license notice, the third-party notices file, and the
"Based on Paperclip (MIT)" attribution line.

## What changed

- **CLI `--help` and banner.** `paperclipai --help` and every subcommand help
  text describe "Myrmidon". The startup banner prints the Myrmidon wordmark.
  The function name (`printPaperclipCliBanner`) and the module path
  (`cli/src/utils/banner.ts`) stay vendor-compatible.
- **CLI messages.** Onboarding, doctor, service manager, update, worktree,
  test-drive, client subcommand help, HTTP client errors, and check repair
  hints use the product name from a single constant,
  `cli/src/myrmidon-product.ts` (`PRODUCT_NAME`).
- **API error responses and descriptions.** OpenAPI `summary`/`description`
  fields, route error messages, config validation errors, workspace
  reconciliation messages, and secrets-provider guidance name Myrmidon
  (server constant: `server/src/myrmidon/product.ts`).
- **Onboarding documents for external agents** (`routes/access.ts`) name
  Myrmidon in the rendered text.
- **Outgoing request user agents** (for example `Paperclip/1.0` →
  `Myrmidon/1.0`).
- **Node version warning** (`packages/shared/src/node-version.ts`): the
  warning prefix is `[myrmidon]` and the restart line says Myrmidon.
- **Org chart SVG** wordmark.

## What did NOT change (compatibility surface)

- Package name `paperclipai`, the `paperclipai` bin, and the `/paperclip`
  Discord slash command.
- Environment variables (`PAPERCLIP_*`), HTTP headers (`X-Paperclip-*`),
  `@paperclipai/*` packages, API paths, the `paperclip_runner` adapter type.
- `~/.paperclip` state directory paths.
- MCP server names "Paperclip connections" and "Paperclip projects" — these
  are session identity keys used by adapters; renaming them once would reset
  every native session.
- Frozen pre-rename snapshots (`priorCloseCopyDefinition`,
  `preBrandingDefinition`, `LEGACY_*` notice bodies) — they recognize data
  written before the rename.
- External vendor services: Paperclip Cloud, Paperclip Labs, Paperclip EE,
  Paperclip Enterprise.
- The MIT attribution "Based on Paperclip (MIT)".

## Where the product name lives

| Surface | Constant |
| --- | --- |
| UI | `ui/src/lib/myrmidon-product.ts` |
| Server text | `server/src/myrmidon/product.ts` |
| CLI text | `cli/src/myrmidon-product.ts` |
| Shared node-version warning | literal in `packages/shared/src/node-version.ts` (tied by tests) |

A guard test in each area fails if the copies drift apart.

## Guard tests

- `cli/src/__tests__/cli-product.myrmidon.test.ts` — banner and name-constant
  sync with the server module.
- `server/src/__tests__/server-user-text.myrmidon.test.ts` — scans the
  renamed server files for stray vendor-name user text outside the allowlist,
  and checks the generated OpenAPI output (attribution, Cloud service names,
  and contract field names excepted). The OpenAPI scan lives here, not in the
  CLI suite, so the CLI typecheck never has to resolve server modules.

## No settings

This pass changes text only. It introduces no settings and no behavior
changes; nothing appears in `docs/myrmidon/SETTINGS.md`.
