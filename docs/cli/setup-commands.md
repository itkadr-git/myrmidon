---
title: Setup Commands
summary: Onboard, run, doctor, and configure
---

Instance setup and diagnostics commands.

## `myrmidon run`

One-command bootstrap and start:

```sh
pnpm myrmidon run
```

Does:

1. Auto-onboards if config is missing
2. Runs `myrmidon doctor` with repair enabled
3. Starts the server when checks pass

Choose a specific instance:

```sh
npx myrmidon run --instance dev
```

## `myrmidon onboard`

Interactive first-time setup:

```sh
pnpm myrmidon onboard
```

If Myrmidon is already configured, rerunning `onboard` keeps the existing config in place. Use `myrmidon configure` to change settings on an existing install.

First prompt:

1. `Quickstart` (recommended): local defaults (embedded database, no LLM provider, local disk storage, default secrets)
2. `Advanced setup`: full interactive configuration

Start immediately after onboarding:

```sh
pnpm myrmidon onboard --run
```

Quickstart defaults + immediate start:

```sh
pnpm myrmidon onboard --yes
```

When onboarding starts Myrmidon from an interactive terminal, it opens the
onboarding page in your browser once. Non-interactive terminals stay silent.
Suppress browser opening explicitly for headless or automated runs with either
environment variable:

```sh
PAPERCLIP_NO_BROWSER=1 pnpm myrmidon onboard --yes
PAPERCLIP_OPEN_ON_LISTEN=false pnpm myrmidon onboard --yes
```

On an existing install, `--yes` now preserves the current config and just starts Myrmidon with that setup.

## `myrmidon doctor`

Health checks with optional auto-repair:

```sh
pnpm myrmidon doctor
pnpm myrmidon doctor --repair
```

Validates:

- Server configuration
- Database connectivity
- Secrets adapter configuration, including AWS Secrets Manager non-secret env
  config when selected
- Storage configuration
- Missing key files

## `myrmidon configure`

Update configuration sections:

```sh
pnpm myrmidon configure --section server
pnpm myrmidon configure --section secrets
pnpm myrmidon configure --section storage
```

`--section secrets` updates the deployment-level provider used as the fallback
for secrets that do not target a specific company vault. Per-company provider
vaults (named instances, default vault selection, multiple vaults per provider,
coming-soon GCP/Vault) live in the board UI under
`Company Settings → Secrets → Provider vaults` and the
`/api/companies/{companyId}/secret-provider-configs` API.

## `myrmidon env`

Show resolved environment configuration:

```sh
pnpm myrmidon env
```

This now includes bind-oriented deployment settings such as `PAPERCLIP_BIND` and `PAPERCLIP_BIND_HOST` when configured.

## `myrmidon allowed-hostname`

Allow a private hostname for authenticated/private mode:

```sh
npx myrmidon allowed-hostname my-tailscale-host
```

## Local Storage Paths

| Data | Default Path |
|------|-------------|
| Config | `~/.paperclip/instances/default/config.json` |
| Database | `~/.paperclip/instances/default/db` |
| Logs | `~/.paperclip/instances/default/logs` |
| Storage | `~/.paperclip/instances/default/data/storage` |
| Secrets key | `~/.paperclip/instances/default/secrets/master.key` |

Override with:

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm myrmidon run
```

Or pass `--data-dir` directly on any command:

```sh
npx myrmidon run --data-dir ./tmp/paperclip-dev
npx myrmidon doctor --data-dir ./tmp/paperclip-dev
```
