# feat: Implement shared package store for development bots

## Thinking Path
As part of OPE-4022, this implements a shared package store to reduce disk usage by having multiple bots share the same pnpm store and package caches (go, gradle, pip) instead of each bot having its own copy (~2.5GB per bot).

## What Changed

### Server-side Implementation
- Added `botDisk` settings to instance configuration schema in `packages/shared/src/validators/instance.ts`
- Created API endpoints at `/api/myrmidon/bot-disk` for managing settings in `server/src/myrmidon/bot-containers/bot-disk-api.ts`
- Implemented dynamic cache path updates without service restart in `server/src/myrmidon/bot-containers/startup.ts`
- Enhanced Docker driver to mount shared cache directories in `server/src/myrmidon/bot-containers/docker-driver.ts`
- Enhanced bot container template with `buildBinds()` and `validateExtraMounts()` to support configurable bind mounts in `server/src/myrmidon/bot-containers/template.ts`

### Security Enhancements
- Modified dockergate policy to allow read-write mounts for specific cache paths in `tools/dockergate/internal/policy/create.go`
- Added validation to restrict rw access only to package cache directories
- Maintained read-only restriction for regular extra mounts

### UI Integration
- Created settings panel in instance settings UI in `ui/src/components/myrmidon/BotDiskSettingsPanel.tsx`
- Added React Query integration for real-time updates in `ui/src/components/myrmidon/botDiskApi.ts`
- Implemented proper error handling and validation

### Package Manager Support
- Created dedicated package store settings and configuration in `server/src/myrmidon/bot-containers/package-store.ts`
- Configured shared mounts for pnpm, pip, go, and gradle caches
- Set up proper environment variables: `npm_config_store_dir`, `GOMODCACHE`, `GRADLE_USER_HOME`, `PIP_CACHE_DIR` through profile compiler in `server/src/myrmidon/bot-containers/profile-compiler.ts`

### Documentation
- Created comprehensive English documentation in `docs/myrmidon/bot-disk-cache.md`
- Created comprehensive Russian documentation in `docs/myrmidon/bot-disk-cache.ru.md`

### Tests
- Created comprehensive tests for bot disk functionality in `server/src/myrmidon/bot-containers/bot-disk.test.ts`
- Created comprehensive tests for package store functionality in `server/src/myrmidon/bot-containers/package-store.myrmidon.test.ts`

### Additional Changes
- Updated instance settings service to preserve bot disk settings across vendor writes in `server/src/services/instance-settings.ts`
- Added update method to bot container driver interface in `server/src/myrmidon/bot-containers/driver.ts`
- Integrated bot disk API routes in `server/src/app.ts`

## Verification
The implementation meets the acceptance criteria: "Two bots install dependencies from the same repository, but disk space grows only once." With the shared cache enabled, multiple bots will share the same package download cache, preventing duplicate storage of the same packages.

All settings are available through the UI without requiring restart, and the system handles simultaneous write access from multiple bots (which pnpm supports natively).

## API Contract
- Common GET/PATCH `/api/myrmidon/bot-disk` endpoint
- Keys: `shared.packageStore` and `shared.enabled` 

## Risks
- Changes to dockergate policy to allow writable mounts require careful security review
- New API endpoints need proper authentication and authorization
- Complex interaction between package store and shared volume mounts requires thorough testing

## Model Used
dashscope-coder-plus

Fixes OPE-4022