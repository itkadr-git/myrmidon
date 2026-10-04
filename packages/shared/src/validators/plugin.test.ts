import { describe, it, expect } from 'vitest';
import { pluginManifestV1Schema } from '@paperclipai/shared';

describe('Plugin Manifest V1 Schema', () => {
  it('should accept a manifest with requiresEntitlement field', () => {
    const validManifest = {
      id: 'test-plugin',
      apiVersion: 1,
      version: '1.0.0',
      displayName: 'Test Plugin',
      description: 'A test plugin',
      author: 'Test Author',
      categories: ['testing'],
      capabilities: ['ui.sidebar.register'],
      entrypoints: { worker: './dist/worker.js' },
      requiresEntitlement: true
    };

    const result = pluginManifestV1Schema.safeParse(validManifest);
    expect(result.success).toBe(true);
  });

  it('should accept a manifest without requiresEntitlement field', () => {
    const validManifest = {
      id: 'test-plugin',
      apiVersion: 1,
      version: '1.0.0',
      displayName: 'Test Plugin',
      description: 'A test plugin',
      author: 'Test Author',
      categories: ['testing'],
      capabilities: ['ui.sidebar.register'],
      entrypoints: { worker: './dist/worker.js' }
    };

    const result = pluginManifestV1Schema.safeParse(validManifest);
    expect(result.success).toBe(true);
  });
});