# `@myrmidon/plugin-docker`

Docker sandbox provider plugin for Paperclip environments (skeleton package).

Это каркас пакета провайдера, содержащий манифест и заглушки хуков жизненного цикла окружения; логика Docker и dockergate реализуется в OPE-12633.

See [SANDBOX-REQUIREMENTS.md](../SANDBOX-REQUIREMENTS.md) for sandbox runtime requirements and security boundaries.

## Local development

```bash
cd packages/plugins/sandbox-providers/docker
pnpm install --ignore-workspace --no-lockfile
pnpm build
pnpm test
pnpm typecheck
```

These commands assume the repo root has already been installed once so the local `@myrmidon/plugin-sdk` workspace package is available to the compiler during development.

## Package layout

- `src/manifest.ts` declares the sandbox-provider driver metadata
- `src/plugin.ts` implements the environment lifecycle hooks (stubs)
- `paperclipPlugin.manifest` and `paperclipPlugin.worker` point the host at the built plugin entrypoints in `dist/`
