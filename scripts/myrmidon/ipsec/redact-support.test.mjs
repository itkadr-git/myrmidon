import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./redact-support.mjs', import.meta.url));
const pem = (secret) => ['-----BEGIN ' + 'PRIVATE KEY-----', secret, '-----END ' + 'PRIVATE KEY-----'].join('\n');
function run(format, input) {
  return spawnSync(process.execPath, [cli, '--format', format], { input, encoding: 'utf8' });
}
function noLeak(result, ...secrets) {
  for (const secret of secrets) assert.ok(!(result.stdout + result.stderr).includes(secret));
}

test('JSON nested credentials and PEM are removed while diagnostic fields survive', () => {
  const secrets = ['canaryPsk', 'canaryBearer', 'canaryPem', 'canaryPassword'];
  const input = JSON.stringify({ connections: [{ state: 'ESTABLISHED', bytes_in: 2048, route_prefix: '192.0.2.0/24', PSK: secrets[0], nested: { Authorization: `Bearer ${secrets[1]}`, private_key: pem(secrets[2]), PassWord: secrets[3] } }] });
  const result = run('json', input);
  assert.equal(result.status, 0); noLeak(result, ...secrets);
  const entry = JSON.parse(result.stdout).connections[0];
  assert.equal(entry.state, 'ESTABLISHED'); assert.equal(entry.bytes_in, 2048); assert.equal(entry.route_prefix, '192.0.2.0/24');
  assert.equal(entry.PSK, '[REDACTED]');
});

test('text fields and multiline private key are redacted', () => {
  const input = `state: INSTALLED\nbytes_out: 42\nroute_prefix: 2001:db8::/32\nPSK = canaryPsk\nauthorization: Bearer canaryBearer\nprivate_key: ${pem('canaryPem')}\nsa_state: ESTABLISHED\n`;
  const result = run('text', input);
  assert.equal(result.status, 0); noLeak(result, 'canaryPsk', 'canaryBearer', 'canaryPem');
  assert.match(result.stdout, /state: INSTALLED/); assert.match(result.stdout, /bytes_out: 42/); assert.match(result.stdout, /2001:db8::\/32/);
  assert.match(result.stdout, /authorization: \[REDACTED\]/); assert.match(result.stdout, /private_key: \[REDACTED\]/);
  assert.match(result.stdout, /sa_state: ESTABLISHED/);
});

test('unsupported and malformed input fails without output or source in errors', () => {
  for (const [format, input] of [['yaml', 'secret: canaryUnknown'], ['json', '{"password":"canaryBroken"'], ['text', 'unrecognised canaryLine'], ['text', 'private_key: -----BEGIN ' + 'PRIVATE KEY-----\ncanaryIncomplete'], ['json', '{"note":"canaryUnknown"}']]) {
    const result = run(format, input); assert.notEqual(result.status, 0); assert.equal(result.stdout, ''); noLeak(result, 'canaryUnknown', 'canaryBroken', 'canaryLine', 'canaryIncomplete');
  }
});

test('secret containers and case variants never expose descendants', () => {
  const result = run('json', JSON.stringify({ secret: { data: ['canaryNested'] }, API_TOKEN: 'canaryToken', state: 'UP', bytes_out: 0 }));
  assert.equal(result.status, 0); noLeak(result, 'canaryNested', 'canaryToken');
});
