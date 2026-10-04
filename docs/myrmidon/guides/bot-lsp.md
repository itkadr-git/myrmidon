# BOT-LSP Configuration Guide

This guide explains how to configure Language Server Protocol (LSP) settings for bots in the Myrmidon system.

## Overview

The BOT-LSP feature allows controlling language server behavior in bot containers to optimize resource usage. This is particularly important for reducing memory consumption from tsserver processes that can accumulate on the host.

## Configuration Structure

LSP settings can be configured at two levels:

1. **Instance defaults** - Applied globally to all bots on the instance
2. **Per-agent overrides** - Specific settings for individual agents that override instance defaults

### Available Settings

#### `enabled` (boolean)
- Controls whether LSP support is enabled for the bot
- Default: `true`

#### `idleTimeout` (number)
- Timeout in seconds after which idle language servers are shut down
- Default: `600` (10 minutes)
- Recommended for development: `120` to save memory

#### `excludeRoots` (string[])
- Glob patterns to exclude from language server analysis
- Useful for excluding monorepos that are checked separately
- Examples: `['**/myrmidon/**', '/workspace/*/repo']`

#### `waitMode` (string)
- Wait mode for language server responses ('sync' or 'async')
- Default: 'sync'

#### `servers` (Record<string, any>)
- Per-server configuration overrides
- Allows fine-tuning individual language servers

## Usage Examples

### Instance-Level Configuration (Development)

To configure all development bots with shorter timeouts and exclude monorepo paths:

```typescript
{
  instanceDefaults: {
    lsp: {
      enabled: true,
      idleTimeout: 120,  // 2 minutes instead of 10
      excludeRoots: ['**/myrmidon/**', '/workspace/*/repo'],
      waitMode: 'sync'
    }
  }
}
```

### Agent-Level Override

To override settings for a specific agent:

```typescript
{
  lsp: {
    enabled: false,      // Disable LSP for this agent
    idleTimeout: 60      // 1 minute timeout
  }
}
```

### Combining Instance and Agent Settings

When both instance defaults and agent-specific settings are provided, agent settings take precedence:

```typescript
// Instance defaults
{
  instanceDefaults: {
    lsp: {
      enabled: true,
      idleTimeout: 120,
      excludeRoots: ['**/myrmidon/**']
    }
  },
  // Agent override
  lsp: {
    enabled: false,           // Overrides instance value
    excludeRoots: ['**/test/**']  // Overrides instance value
    // idleTimeout remains 120 from instance default
  }
}
```

### Server-Specific Configuration

Fine-tune individual language servers:

```typescript
{
  lsp: {
    servers: {
      tsserver: {
        memoryLimit: 1024,
        maxOldSpaceSize: 1024
      },
      eslint: {
        configFile: '.eslintrc.js'
      }
    }
  }
}
```

## Memory Optimization

The primary goal of BOT-LSP configuration is to reduce memory consumption:

- Set `idleTimeout` to lower values (e.g., 120 seconds) for development environments
- Use `excludeRoots` to exclude monorepositories that are checked separately via `devbuild`
- Consider disabling LSP entirely for bots working on large monorepos

## Integration with devbuild

For monorepository projects, LSP configuration complements the `devbuild` system:

- Exclude monorepo paths using `excludeRoots`
- Let `devbuild` handle type checking and validation during builds
- Use shorter `idleTimeout` values to reduce memory footprint during development

## Divergence Notes

This configuration system diverges from the original Hermes configuration by providing bot-specific LSP controls that integrate with the Myrmidon container orchestration system. The original Hermes LSP settings are typically configured in `hermes_cli/config_defaults.py`, while this system provides container-level controls through the bot profile compilation process.