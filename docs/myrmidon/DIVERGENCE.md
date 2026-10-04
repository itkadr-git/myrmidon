# Divergence Log

This document tracks modifications made to vendor files to implement custom functionality.

## Modified Files

### packages/shared/src/validators/plugin.ts
- **What**: Added `requiresEntitlement` field to plugin manifest schema
- **Where**: In `pluginManifestV1Schema` definition
- **Why**: To support plugin entitlement key requirement
- **Test**: Verify that manifests with `requiresEntitlement` field validate correctly
- **When to remove**: Never - this is a permanent feature addition

### packages/shared/src/types/plugin.ts
- **What**: Added `requiresEntitlement` field to PaperclipPluginManifestV1 interface
- **Where**: In the PaperclipPluginManifestV1 type definition
- **Why**: To support plugin entitlement key requirement
- **Test**: Verify that manifests with `requiresEntitlement` field type-check correctly
- **When to remove**: Never - this is a permanent feature addition

### packages/shared/src/validators/instance.ts
- **What**: Added `pluginEntitlementKeysSchema` and integrated it into instance settings
- **Where**: Added import and included in `instanceGeneralSettingsSchema`
- **Why**: To store plugin entitlement keys in instance settings
- **Test**: Verify that instance settings can store and retrieve plugin entitlement keys
- **When to remove**: Never - this is a permanent feature addition

### packages/shared/src/types/instance.ts
- **What**: Added `pluginEntitlementKeys` field to InstanceGeneralSettings interface
- **Where**: In the InstanceGeneralSettings type definition
- **Why**: To support storing plugin entitlement keys in instance settings
- **Test**: Verify that instance settings type includes the new field
- **When to remove**: Never - this is a permanent feature addition

### server/src/services/instance-settings.ts
- **What**: Added preservation logic for plugin entitlement keys during settings updates
- **Where**: Added import and integration in the updateGeneral method
- **Why**: To ensure plugin entitlement keys persist during other settings updates
- **Test**: Verify that plugin entitlement keys remain intact when other settings are updated
- **When to remove**: Never - this is a permanent feature addition

### server/src/myrmidon/plugin-entitlement/store.ts
- **What**: Created new module to preserve plugin entitlement keys across vendor writes
- **Where**: New file in server/src/myrmidon/plugin-entitlement/
- **Why**: To maintain plugin entitlement keys during vendor updates
- **Test**: Verify that keys persist across different settings update scenarios
- **When to remove**: Never - this is a permanent feature addition

### server/src/myrmidon/plugin-entitlement/validation.ts
- **What**: Created new module to validate plugin entitlement keys
- **Where**: New file in server/src/myrmidon/plugin-entitlement/
- **Why**: To validate plugin license keys and manage plugin activation
- **Test**: Verify that valid keys are accepted and invalid/expired keys are rejected
- **When to remove**: Never - this is a permanent feature addition

### server/src/services/plugin-entitlement-enforcement.ts
- **What**: Created new service to enforce plugin entitlement requirements
- **Where**: New file in server/src/services/
- **Why**: To integrate entitlement validation with plugin lifecycle
- **Test**: Verify that plugins with valid keys are enabled and those without are disabled
- **When to remove**: Never - this is a permanent feature addition

### ui/src/components/myrmidon/PluginEntitlementSettingsPanel.tsx
- **What**: Created UI component for managing plugin entitlement keys
- **Where**: New file in ui/src/components/myrmidon/
- **Why**: To provide UI for adding/removing/viewing plugin keys
- **Test**: Verify that users can add, view, and remove plugin keys
- **When to remove**: Never - this is a permanent feature addition

### ui/src/i18n/locales/en/plugin-entitlement.json
- **What**: Added English localization strings for plugin entitlement UI
- **Where**: New file in ui/src/i18n/locales/en/
- **Why**: To provide English translations for the plugin entitlement UI
- **Test**: Verify that English UI displays correctly with proper translations
- **When to remove**: Never - this is a permanent feature addition

### ui/src/i18n/locales/ru/plugin-entitlement.json
- **What**: Added Russian localization strings for plugin entitlement UI
- **Where**: New file in ui/src/i18n/locales/ru/
- **Why**: To provide Russian translations for the plugin entitlement UI
- **Test**: Verify that Russian UI displays correctly with proper translations
- **When to remove**: Never - this is a permanent feature addition