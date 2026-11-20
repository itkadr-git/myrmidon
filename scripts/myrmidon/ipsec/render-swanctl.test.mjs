import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const script = new URL('./render-swanctl.mjs', import.meta.url);
const fixture = new URL('./example.json', import.meta.url);
const config = JSON.parse(readFileSync(fixture, 'utf8'));
const run = (input) => spawnSync(process.execPath, [script.pathname], { input: JSON.stringify(input), encoding: 'utf8' });

test('renders the golden configuration deterministically', () => {
  const first = run(config);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, readFileSync(new URL('./example.swanctl.conf', import.meta.url), 'utf8'));
  assert.equal(run(config).stdout, first.stdout);
});

test('rejects missing required fields without output', () => {
  for (const key of Object.keys(config)) {
    const input = { ...config };
    delete input[key];
    const result = run(input);
    assert.notEqual(result.status, 0, key);
    assert.equal(result.stdout, '', key);
  }
});

test('rejects configuration injection and inline secrets without output', () => {
  for (const input of [
    { ...config, name: 'x }\nconnections { evil' },
    { ...config, local: { ...config.local, identity: 'x"\n secrets { evil' } },
    { ...config, secretFile: '/etc/ipsec.secrets\ninclude /tmp/evil' },
    { ...config, secret: 'not-a-reference' },
    { ...config, proposals: ['aes256-sha256-modp2048,default'] },
  ]) {
    const result = run(input);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
});
