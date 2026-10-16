# Shared Mount Feature

## Overview
The shared mount feature enables bots to access a common directory with controlled read/write access. This replaces the previous system where each bot had its own copy of shared data using hard links, which prevented files created by one bot from being visible to others.

## Configuration

### Instance-Level Settings
The shared mount feature is configured at the instance level through the instance settings. The following options are available:

- **enabled**: Whether the shared mount feature is enabled for this instance
- **hostPath**: The host path for the shared directory (defaults to `MYRMIDON_BOT_VOLUME_ROOT/shared`)
- **writable**: Whether bots can write to the shared directory
- **allowedBots**: Allowlist of bot IDs that can access the shared directory

### Bot-Level Access Control
Individual bots can be granted access to the shared directory through the bot configuration. Access is granted based on the instance settings and the bot's ID being in the allowlist.

## Usage
When the shared mount feature is enabled and a bot has access, a shared directory will be mounted at `/shared` in the bot's container. The mount is read-write when `writable` is true and read-only otherwise. It is part of the container's create body, so a change of the setting reaches an existing bot through the normal template-drift recreate (maintenance window), not instantly. Files placed in this directory by one bot will be visible to other bots that have access to the shared directory.

## Migration
When a container with the shared mount is created, files left in the bot's old `shared` directory are moved into the shared directory. The move never deletes anything: a file whose name already exists in the shared directory, or whose move fails, stays where it was, and the old directory is removed only when it ended up empty.