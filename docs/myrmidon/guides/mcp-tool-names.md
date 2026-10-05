# Rebrand D: board MCP tool names are `myrmidon*`, old names are aliases

> Русская версия: [mcp-tool-names.ru.md](mcp-tool-names.ru.md)

This guide documents the 1.7 REBRAND D pass: the board's MCP
server (`packages/mcp-server`) publishes every tool under a `myrmidon*` name.
The old `paperclip*` names keep working as deprecated aliases for exactly one
release, so already-installed systems and agent skills do not break.

## What changed

- **Tool list.** `createPaperclipMcpServer` registers the 42 board tools as
  `myrmidonMe`, `myrmidonListIssues`, `myrmidonUpdateIssue`,
  `myrmidonCheckoutIssue`, `myrmidonAddComment`, `myrmidonApiRequest`, …
  The new name is always the old one with the `paperclip` prefix replaced by
  `myrmidon` (same remainder, same casing).
- **Deprecated aliases.** Each old name is still registered, bound to the very
  same schema object and the very same handler function (not a re-implementation),
  and its description carries the marker
  `(deprecated alias for <newName>; will be removed after the 1.7 release)`.
- **Names unchanged.** The run-scoped connection tools `connections_search`
  and `connection_request` have no vendor prefix and keep their names.

The implementation is one mapping module,
`packages/mcp-server/src/tool-aliases.ts`, applied at registration in
`packages/mcp-server/src/index.ts`. `tools.ts` itself is intentionally
unchanged: `packages/paperclip-runner` parses the `makeTool("paperclip…")`
literals (names, descriptions, line numbers) out of that file for its
capability-inventory contract checks, so renaming the literals or their
descriptions here would be a second, separate contract change (see
"Diagnostics that pin old names" below).

## What did NOT change (compatibility surface)

- `PAPERCLIP_API_URL` / `PAPERCLIP_API_KEY` and the other environment
  variables of the server — those belong to REBRAND C (`MYRMIDON_*` aliases).
- The `@paperclipai/mcp-server` package name and the `paperclip-mcp-server`
  bin — package renames are out of scope for this phase (pending the epic's
  package-rename decision).
- The MCP `serverInfo` name `paperclip` — it is protocol metadata that some
  clients use as a connection key; renaming it is a separate compat decision.
- Tool descriptions still contain the word "Paperclip" where the vendor wrote
  them, because the runner's committed capability inventories pin those exact
  strings (changing one requires regenerating the spec against the eval
  corpus, which is a full-tier contract task, not part of D).
- HTTP header names (`X-Paperclip-*`), API paths, and everything outside the
  MCP tool catalog.

## Diagnostics that pin old names

- `packages/paperclip-runner/scripts/check-capability-inventory.mjs` compares
  the committed `spec/capability/mcp-tool-map.yaml` rows (tool name,
  description, `sourceAnchor` line number in `tools.ts`) against the live
  `tools.ts` parse. Old-name `makeTool` literals must stay where they are
  until the spec is regenerated with the eval corpus.
- `packages/paperclip-runner/spec/capability/eval-traceability.yaml` and
  `protocol-coverage.json` reference the old names as traceability ids
  (`mcp:paperclipMe`, …). They keep pointing at the alias rows.

## Removing the aliases (planned: 1.8)

1. Confirm no installed system, agent skill, or external MCP gateway config
   still calls a `paperclip*` tool name (board audit).
2. Rename the `makeTool("paperclip…")` literals in `packages/mcp-server/src/tools.ts`
   to `myrmidon…` and delete `tool-aliases.ts`, its test, and the
   `withMyrmidonToolNames(...)` call in `index.ts`.
3. Regenerate the runner contracts in the same PR
   (`PAPERCLIP_EVALS_ROOT` set; `pnpm --filter @paperclipai/paperclip-runner
   generate:capability-inventory && generate:capability-contract &&
   generate:protocol-coverage`). The fold map in
   `packages/paperclip-runner/scripts/lib/capability-inventory.mjs`
   (`legacyMcpFoldTargets`) must gain the `myrmidon*` rows and keep the
   `paperclip*` rows only if a final transition release still ships them.
4. Remove the row from DIVERGENCE.md and this guide.

## How to verify

- Tests: `pnpm --filter @paperclipai/mcp-server test` —
  `src/tool-aliases.test.ts` checks the mapping covers all 42 old names, that
  the published list contains the `myrmidon*` names, that every old name is
  registered with a `deprecated` marker in its description, that both names
  share one handler reference, and that both names hit the identical API call.
- Manual check (stdio): start the server with `PAPERCLIP_API_URL`/`PAPERCLIP_API_KEY`
  set, call `tools/list`, confirm `myrmidonMe` and `paperclipMe` both appear and
  only the latter's description says deprecated; call either one.
