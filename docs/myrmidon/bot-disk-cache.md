# Shared Package Cache for Bot Containers (1.6.1)

## Overview
The shared package cache feature allows multiple development bots to share common package caches (pnpm, pip, go, gradle) to reduce disk usage and improve performance. Instead of each bot maintaining its own copy of downloaded packages, they can share a common cache directory.

## Configuration
The shared package cache can be configured through the instance settings UI:

1. Navigate to the "Bot Disk Settings" section in the instance settings
2. Set the "Shared Package Cache Path" to a directory accessible by all bot containers
3. Save the settings

Alternatively, the settings can be managed via the API at `/api/myrmidon/bot-disk`.

## Supported Package Managers
The feature currently supports caching for:

- **pnpm**: Shared store at `/.pnpm-store`
- **pip**: Shared cache at `/.cache/pip`
- **Go**: Shared build cache at `/.cache/go-build`
- **Gradle**: Shared cache at `/.gradle`

## Technical Implementation
When configured, bot containers will have the following bind mounts:

- `${SHARED_CACHE_PATH}/pnpm:/home/user/.pnpm-store:rw`
- `${SHARED_CACHE_PATH}/pip:/home/user/.cache/pip:rw`
- `${SHARED_CACHE_PATH}/go:/home/user/.cache/go-build:rw`
- `${SHARED_CACHE_PATH}/gradle:/home/user/.gradle:rw`

These mounts are read-write to allow package managers to update the cache with newly downloaded packages.

## Security Considerations
- Only specific cache directories are allowed to be mounted as read-write
- Regular extra mounts remain read-only for security
- Dockergate validates that only cache paths can use read-write mode

## Benefits
- **Reduced disk usage**: Multiple bots share the same package downloads
- **Improved performance**: Cached packages don't need to be re-downloaded
- **Consistent builds**: Shared cache ensures consistent package versions

## Requirements
- Docker access for bot containers
- A shared filesystem location accessible by all bot containers
- Appropriate permissions for the shared cache directory