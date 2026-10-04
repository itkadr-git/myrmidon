# Instance Settings

This document describes all settings configurable in the instance settings page.

## General Settings

- **censorUsernameInLogs**: When true, usernames are redacted from activity logs for privacy compliance.
- **keyboardShortcuts**: Enables enhanced keyboard navigation throughout the application.
- **feedbackDataSharingPreference**: Controls whether usage data is shared for product improvement.
- **backupRetention**: Sets retention policies for daily, weekly, and monthly backups.
- **executionMode**: Restricts execution to specific environments (e.g., Kubernetes only).
- **workspaceHygiene**: Disk quota limits for execution workspaces.
- **runLimits**: Admission limits for agent runs.
- **hostDisk**: Host disk usage threshold for automated cleanup.
- **parallelHelpers**: Settings for parallel helper subagents.
- **browserBridge**: Allowlist of domains for browser bridge functionality.
- **swarmClaim**: Settings for per-role task queues with leased claims.
- **wipLimit**: Per-agent WIP limits.
- **pluginEntitlementKeys**: License keys required to enable certain plugins.

## Experimental Settings

- **enableEnvironments**: Enables environment management features.
- **enableNativeRunner**: Exposes the experimental Paperclip Runner adapter.
- **enableManagedSandboxOnly**: Forces all agents to run in managed sandbox environments.
- **enableIsolatedWorkspaces**: Enables isolated execution workspaces.
- And more experimental features...

## Plugin Entitlement Keys

The `pluginEntitlementKeys` setting contains an array of license keys that enable premium plugins. Each key object contains:

- **key**: The license key string
- **pluginId**: The ID of the plugin the key enables
- **issuedAt**: The date the key was added
- **expiresAt**: The expiration date (if applicable)
- **status**: The current status (valid, expired, invalid)