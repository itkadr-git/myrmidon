# Bot language servers (BOT-LSP)

> Russian version: [bot-lsp.ru.md](bot-lsp.ru.md)

Hermes starts a language server for every git worktree a bot edits in, to report diagnostics
after an edit. On a TypeScript monorepo each one is a tsserver of about 1 GB, and
typescript-language-server starts a second ("syntax") tsserver next to it; both stay for
`idle_timeout` (600 s by default) after the last use. Most bots never write code, and the ones
that do get the monorepo typecheck from the build server anyway, so Myrmidon decides the
language-server mode per bot.

## The policy

| Bot | Mode by default |
|---|---|
| Role (caste) writes code: `engineer`, `qa`, `devops`, `reviewer`, `release` | `limited` |
| Any other role, or no role | `off` |

- `off` — `lsp.enabled: false`: no language server, no LSP event loop.
- `limited` — one tsserver per worktree (`tsserver.useSyntaxServer: "never"`), no automatic
  typings download (`disableAutomaticTypingAcquisition`), adaptive heap cap `maxTsServerMemory`
  (40% of container memory, reserving 60% for Hermes/botd; e.g. 409 MB for a standard 1024 MB container,
  307 MB for 768 MB), `idle_timeout` 120 s. If container memory is unknown or insufficient (< 640 MB,
  minimum viable heap is 256 MB), limited LSP safely disables itself with a warning.
- `full` — Hermes' own server defaults, with `lsp.enabled: true` and default workspace exclusions (`node_modules`, `dist`) written so the monorepo scan stays bounded. This adds an `lsp` block compared with earlier profiles that left the block absent; server behavior remains Hermes' default apart from excluded roots.

## Where to change it

- **Instance policy** — Instance settings → General → "Bot language servers"
  (`GET`/`PATCH /api/myrmidon/bot-lsp`): the coding roles (custom castes too), the mode for
  coding and other roles, the idle timeout, the memory cap and excluded workspace roots. When no active
  bot containers exist, PATCH falls back to validating against the default 1024 MB container (cap 409 MB).
  If container memory is reduced below a saved `tsserverMemoryMb`, runtime profiles safely clamp heap to 40%
  of the new limit with an explicit warning, and the settings view flags the mismatch. The panel also
  shows how many bots run in each mode.
- **One agent** — the agent card's "Language servers" section pins a mode
  (`adapterConfig.lsp.mode`); "By role" removes the pin.

Neither needs a server restart. The profile compiler re-reads the policy on every reconcile
tick; a changed `lsp` block is a `config.yaml` change, which the reconciler applies while the
bot is paused (the same path a model change takes). The field reference is in
[SETTINGS.md](../SETTINGS.md#162--bot-lsp-defaults-bot-language-servers-by-role).

## What reaches Hermes

The compiler writes Hermes' `lsp` block (`hermes_cli/config_defaults.py`). The limited mode's
tsserver preferences go through `lsp.servers.typescript.initialization_options`, which Hermes
passes unchanged as the LSP `initializationOptions` of typescript-language-server (registry id
`typescript`):

```yaml
lsp:
  enabled: true
  idle_timeout: 120
  servers:
    typescript:
      initialization_options:
        disableAutomaticTypingAcquisition: true
        maxTsServerMemory: 409
        tsserver:
          useSyntaxServer: "never"
```

The compiler input (`HermesProfileLspSettings`: `enabled`, `idleTimeout`, `excludeRoots`,
`waitMode`, `servers`) also accepts an instance default (`instanceDefaults.lsp`) merged under
the per-agent value; the role policy fills the per-agent value.
