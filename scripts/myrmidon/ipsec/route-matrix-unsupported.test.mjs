import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareRoutes } from './route-matrix.mjs';

const expected = { prefix: '198.51.100.0/24', table: 'main', via: '192.0.2.1', dev: 'eth0' };
const matching = { dst: '198.51.100.0/24', gateway: '192.0.2.1', dev: 'eth0' };
const unsupported = [
  ['multipath', { multipath: [{ gateway: '192.0.2.2', dev: 'eth1' }] }],
  ['nexthops', { nexthops: [{ gateway: '192.0.2.2', dev: 'eth1' }] }],
  ['nhid', { nhid: 42 }],
  ['non-unicast type', { type: 'blackhole' }],
];

for (const [name, fields] of unsupported) {
  test(`rejects ${name} even beside a matching route`, () => {
    for (const snapshot of [[{ ...matching, ...fields }], [matching, { ...matching, ...fields }], [{ ...matching, ...fields }, matching]]) {
      assert.throws(() => compareRoutes([expected], snapshot), /Unsupported route/);
    }
  });

  test(`CLI rejects ${name} without successful JSON`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-unsupported-'));
    try {
      const expectedPath = join(dir, 'expected.json');
      const snapshotPath = join(dir, 'routes.json');
      writeFileSync(expectedPath, JSON.stringify([expected]));
      writeFileSync(snapshotPath, JSON.stringify([matching, { ...matching, ...fields }]));
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./route-matrix.mjs', import.meta.url)), expectedPath, snapshotPath], { encoding: 'utf8' });
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Unsupported route/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('accepts explicit unicast and omitted type', () => {
  for (const route of [{ ...matching, type: 'unicast' }, matching]) {
    assert.equal(compareRoutes([expected], [route])[0].status, 'ok');
  }
});
