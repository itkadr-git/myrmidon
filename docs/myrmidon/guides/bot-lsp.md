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
  typings download (`disableAutomaticTypingAcquisition`), heap cap `maxTsServerMemory` 1024 MB,
  `idle_timeout` 120 s.
- `full` — Hermes' own defaults (nothing written).

## Where to change it

- **Instance policy** — Instance settings → General → "Bot language servers"
  (`GET`/`PATCH /api/myrmidon/bot-lsp`): the coding roles (custom castes too), the mode for
  coding and other roles, the idle timeout, the memory cap and excluded workspace roots. The
  panel also shows how many bots run in each mode.
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
        maxTsServerMemory: 1024
        tsserver:
          useSyntaxServer: "never"
```

The compiler input (`HermesProfileLspSettings`: `enabled`, `idleTimeout`, `excludeRoots`,
`waitMode`, `servers`) also accepts an instance default (`instanceDefaults.lsp`) merged under
the per-agent value; the role policy fills the per-agent value.
