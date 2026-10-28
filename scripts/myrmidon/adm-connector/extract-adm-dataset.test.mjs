import test from 'node:test';
import assert from 'node:assert/strict';
import { scrubSecrets, parseSessionMessages, sampleDataset } from './extract-adm-dataset.mjs';

test('scrubSecrets redacts tokens, bearer headers, and keys', () => {
  const input = `
    Auth header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz123
    Paperclip token: pcp_dummy_invite_live_test
    GitHub token: ghp_dummyfaketokenfortestingonly123
    Secret variable: api_key="secret-key-value-12345"
    Private key:
    -----BEGIN RSA PRIVATE KEY-----
    MIIEowIBAAKCAQEA0m...
    -----END RSA PRIVATE KEY-----
  `;

  const scrubbed = scrubSecrets(input);
  assert.ok(!scrubbed.includes('pcp_invite_live'));
  assert.ok(!scrubbed.includes('ghp_11223344'));
  assert.ok(!scrubbed.includes('eyJhbGciOi'));
  assert.ok(!scrubbed.includes('secret-key-value-12345'));
  assert.ok(!scrubbed.includes('MIIEowIBAAKCAQEA0m'));
  assert.ok(scrubbed.includes('[REDACTED_PCP_TOKEN]'));
  assert.ok(scrubbed.includes('[REDACTED_GH_TOKEN]'));
  assert.ok(scrubbed.includes('[REDACTED_BEARER]'));
  assert.ok(scrubbed.includes('[REDACTED_PRIVATE_KEY]'));
});

test('parseSessionMessages handles Claude Code and JSONL session formats', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', message: { text: 'Deploy the latest release to stage' }, timestamp: '2026-10-21T10:00:00Z' }),
    JSON.stringify({ type: 'assistant', message: { text: 'Running deploy script...' } }),
    JSON.stringify({ role: 'user', content: 'Check ssh connection to agent node', timestamp: '2026-10-22T14:30:00Z' }),
    JSON.stringify({ type: 'tool_result', content: 'Connection timed out' })
  ].join('\n');

  const parsed = parseSessionMessages(jsonl);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].text, 'Deploy the latest release to stage');
  assert.equal(parsed[0].timestamp, '2026-10-21T10:00:00Z');
  assert.equal(parsed[1].text, 'Check ssh connection to agent node');
  assert.equal(parsed[1].timestamp, '2026-10-22T14:30:00Z');
});

test('sampleDataset selects exactly 50 messages using uniform stride within UTC window', () => {
  const raw = [];
  const baseTime = new Date('2026-10-20T00:00:00Z').getTime();

  // Create 150 candidate messages spread over 6 days
  for (let i = 0; i < 150; i++) {
    const ts = new Date(baseTime + i * 3600 * 1000).toISOString();
    raw.push({
      text: `Test operational prompt #${i} for task OPE-${1000 + i}`,
      timestamp: ts
    });
  }

  // Also add out-of-window messages
  raw.push({
    text: 'Early message out of window',
    timestamp: '2026-10-19T23:59:00Z'
  });
  raw.push({
    text: 'Late message out of window',
    timestamp: '2026-10-27T00:01:00Z'
  });

  const dataset = sampleDataset(raw, {
    startUtc: '2026-10-20T00:00:00Z',
    endUtc: '2026-10-27T00:00:00Z',
    targetCount: 50
  });

  assert.equal(dataset.length, 50);

  const startMillis = new Date('2026-10-20T00:00:00Z').getTime();
  const endMillis = new Date('2026-10-27T00:00:00Z').getTime();

  // Check structure
  for (const item of dataset) {
    assert.ok(typeof item.id === 'number');
    assert.ok(item.id >= 1 && item.id <= 50);
    assert.ok(typeof item.text === 'string');
    assert.ok(item.scrubbed === true);
    const itemMillis = new Date(item.timestamp_utc).getTime();
    assert.ok(itemMillis >= startMillis, `Timestamp should be >= start: ${item.timestamp_utc}`);
    assert.ok(itemMillis < endMillis, `Timestamp should be < end: ${item.timestamp_utc}`);
    assert.ok(!item.text.includes('out of window'));
  }

  // Check uniform distribution / monotonic timestamps
  for (let i = 1; i < dataset.length; i++) {
    const prev = new Date(dataset[i - 1].timestamp_utc).getTime();
    const curr = new Date(dataset[i].timestamp_utc).getTime();
    assert.ok(curr >= prev, `Timestamps should be ordered: ${dataset[i - 1].timestamp_utc} <= ${dataset[i].timestamp_utc}`);
  }
});
