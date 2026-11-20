import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareRoutes } from './route-matrix.mjs';

const lan = { prefix: '198.51.100.0/24', table: 'main', via: '192.0.2.1', dev: 'eth0' };
const observed = { dst: '198.51.100.0/24', gateway: '192.0.2.1', dev: 'eth0' };

test('exact route matches; default is not a LAN route', () => {
  assert.equal(compareRoutes([lan], [observed])[0].status, 'ok');
  assert.equal(compareRoutes([lan], [{ ...observed, dst: 'default' }])[0].status, 'missing');
});

test('reports table, gateway, and interface conflicts', () => {
  for (const change of [{ table: 100 }, { gateway: '192.0.2.2' }, { dev: 'eth1' }]) {
    assert.equal(compareRoutes([lan], [{ ...observed, ...change }])[0].status, 'conflicting');
  }
});

test('handles IPv6, default and duplicates without masking conflicts', () => {
  const v6 = { prefix: '2001:db8::/64', table: 100, via: '2001:db8::1', dev: 'tun0' };
  const snapshot = { dst: '2001:db8::/64', table: 100, gateway: '2001:db8::1', dev: 'tun0' };
  assert.equal(compareRoutes([v6], [snapshot, snapshot])[0].status, 'ok');
  assert.equal(compareRoutes([v6], [snapshot, { ...snapshot, dev: 'other' }])[0].status, 'conflicting');
  assert.equal(compareRoutes([{ prefix: 'default', table: 'main', via: null, dev: 'eth0' }], [{ dst: 'default', dev: 'eth0' }])[0].status, 'ok');
});

test('rejects a null snapshot destination instead of treating it as default', () => {
  const expected = { prefix: 'default', table: 'main', via: null, dev: 'eth0' };
  assert.throws(() => compareRoutes([expected], [{ dst: null, dev: 'eth0' }]));
  assert.equal(compareRoutes([expected], [{ dev: 'eth0' }])[0].status, 'ok');
});

test('rejects empty and malformed expectations rather than passing unknown data', () => {
  assert.throws(() => compareRoutes([], []));
  assert.throws(() => compareRoutes([{ prefix: 'nonsense', table: 'main', via: null, dev: 'eth0' }], []));
  assert.throws(() => compareRoutes([{ prefix: 'default' }], []));
});

test('CLI returns 0 for a match, 1 for mismatch, and 2 for invalid input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-matrix-'));
  try {
    const expected = join(dir, 'expected.json');
    const fixture = join(dir, 'routes.json');
    writeFileSync(expected, JSON.stringify([lan]));
    writeFileSync(fixture, JSON.stringify([observed]));
    const run = () => spawnSync(process.execPath, [new URL('./route-matrix.mjs', import.meta.url).pathname, expected, fixture], { encoding: 'utf8' });
    assert.equal(run().status, 0);
    writeFileSync(fixture, '[]');
    assert.equal(run().status, 1);
    writeFileSync(fixture, '{}');
    assert.equal(run().status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
