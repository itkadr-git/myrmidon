import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('./config-check.mjs', import.meta.url).pathname;
const valid = () => ({ sides: [
  { endpoint: '192.0.2.1', localCidr: '192.0.2.0/24', remoteCidr: '198.51.100.0/24', proposal: 'aes256-sha256-modp2048', id: 'left.example', secretFile: '/secrets/left' },
  { endpoint: '192.0.2.2', localCidr: '198.51.100.0/24', remoteCidr: '192.0.2.0/24', proposal: 'aes256-sha256-modp2048', id: 'right.example', secretFile: '/secrets/right' },
] });
function run(manifest) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || tmpdir(), 'ipsec-test-'));
  try {
    const file = join(dir, 'manifest.json');
    writeFileSync(file, typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [cli, file], { encoding: 'utf8' });
    return { status: result.status, output: JSON.parse(result.stdout) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('accepts IPv4 and IPv6 tunnel manifests without opening secret files', () => {
  assert.deepEqual(run(valid()), { status: 0, output: { status: 'PASS', errors: [] } });
  const m = valid();
  Object.assign(m.sides[0], { endpoint: '2001:db8::1', localCidr: '2001:db8:1::/48', remoteCidr: '2001:db8:2::/48' });
  Object.assign(m.sides[1], { endpoint: '2001:db8::2', localCidr: '2001:db8:2::/48', remoteCidr: '2001:db8:1::/48' });
  assert.equal(run(m).status, 0);
});

test('rejects invalid values and never emits PASS', () => {
  for (const mutate of [
    m => { m.sides[0].endpoint = ''; },
    m => { m.sides[0].endpoint = 'example.com'; },
    m => { m.sides[0].localCidr = '192.0.2.0/33'; },
    m => { m.sides[0].remoteCidr = '192.0.2.128/25'; },
    m => { m.sides[1].endpoint = m.sides[0].endpoint; },
    m => { m.sides[0].proposal = ''; },
    m => { m.sides[0].secretFile = ''; },
    m => { m.sides[0].id = null; },
    m => { m.sides[0].psk = 'plaintext'; },
    m => { m.sides[0].localCidr = 12; },
  ]) {
    const m = valid(); mutate(m);
    const result = run(m);
    assert.equal(result.status, 1);
    assert.equal(result.output.status, 'FAIL');
    assert.ok(result.output.errors.length > 0);
    assert.equal(typeof result.output.errors[0].path, 'string');
  }
});

test('rejects malformed JSON and invocation errors with exit 2', () => {
  assert.equal(run('{').status, 2);
  const result = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).status, 'ERROR');
});
