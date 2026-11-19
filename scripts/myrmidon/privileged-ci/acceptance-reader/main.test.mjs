import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './main.mjs';

test('startup rejects absent or invalid configuration before listening', () => {
  for (const config of [undefined, {}, { host: '127.0.0.1', port: 0, credentialDirectory: '.', auditFile: 'audit' }, { host: '127.0.0.1', port: 65536, credentialDirectory: '.', auditFile: 'audit' }]) {
    assert.throws(() => start(config));
  }
});
