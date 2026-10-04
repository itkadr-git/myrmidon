import { PluginManifest } from '@paperclipai/common';

export const manifest: PluginManifest = {
  id: 'test-entitlement-plugin',
  name: 'Test Entitlement Plugin',
  description: 'A test plugin that requires an entitlement key to be enabled',
  version: '1.0.0',
  requiresEntitlement: true, // This flag indicates the plugin requires an entitlement key
  author: 'Paperclip Team',
  homepage: 'https://paperclip.ai',
  license: 'MIT',
  runtime: {
    type: 'standalone',
    entryPoint: './dist/index.js',
  },
  permissions: [],
};