import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { scrubSecrets, parseSessionMessages, sampleDataset, gitleaksScrub, normalizeWhitespace } from './extract-adm-dataset.mjs';

test('scrubSecrets redacts tokens, bearer headers, and keys', () => {
  const input = `
    Auth header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz123
    Board token: pcp_dummy_invite_live_test
    GitHub token: ghp_dummyfaketokenfortestingonly123
    Secret variable: api_key="secret-key-value-12345"
    Password variable: password=super-secret-pass
    Private key:
    -----BEGIN RSA PRIVATE KEY-----
    MIIEowIBAAKCAQEA0m...
    -----END RSA PRIVATE KEY-----
  `;

  const scrubbed = scrubSecrets(input);
  assert.ok(!scrubbed.includes('pcp_dummy_invite_live_test'));
  assert.ok(!scrubbed.includes('ghp_dummyfaketokenfortestingonly123'));
  assert.ok(!scrubbed.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz123'));
  assert.ok(!scrubbed.includes('secret-key-value-12345'));
  assert.ok(!scrubbed.includes('super-secret-pass'));
  assert.ok(!scrubbed.includes('MIIEowIBAAKCAQEA0m'));
  assert.ok(scrubbed.includes('[REDACTED_PCP_TOKEN]'));
  assert.ok(scrubbed.includes('[REDACTED_GH_TOKEN]'));
  assert.ok(scrubbed.includes('[REDACTED_BEARER]'));
  assert.ok(scrubbed.includes('[REDACTED_SECRET]'));
  assert.ok(scrubbed.includes('[REDACTED_PRIVATE_KEY]'));
});

test('window boundaries, missing timestamps and insufficient data fail closed', () => {
  const start = '2026-10-20T00:00:00Z';
  const end = '2026-10-27T00:00:00Z';
  const candidates = [
    { text: 'start boundary', timestamp: start },
    { text: 'end boundary', timestamp: end },
    { text: 'no timestamp' },
    { text: 'bad timestamp', timestamp: 'not-a-date' },
    { text: 'outside', timestamp: '2026-10-19T23:59:59Z' }
  ];
  const options = { startUtc: start, endUtc: end, targetCount: 1, scan: text => text };
  assert.deepEqual(sampleDataset(candidates, options).map(item => item.text), ['start boundary']);
  assert.throws(() => sampleDataset(candidates, { ...options, targetCount: 2 }), /Only 1 eligible messages/);
  assert.throws(() => sampleDataset(candidates, { ...options, startUtc: 'invalid' }), /Invalid UTC window/);
});

test('gitleaksScrub handles clean text (exit 0) and leak detected (exit 1)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'mock-gitleaks-'));
  const cleanBin = join(tmpDir, 'mock-gitleaks-clean.sh');
  const leakBin = join(tmpDir, 'mock-gitleaks-leak.sh');
  const errorBin = join(tmpDir, 'mock-gitleaks-error.sh');

  writeFileSync(cleanBin, '#!/bin/sh\ncat > /dev/null 2>&1 || true\nexit 0\n', { mode: 0o755 });
  writeFileSync(leakBin, '#!/bin/sh\ncat > /dev/null 2>&1 || true\nexit 1\n', { mode: 0o755 });
  writeFileSync(errorBin, '#!/bin/sh\ncat > /dev/null 2>&1 || true\nexit 2\n', { mode: 0o755 });

  // Happy path: exit 0 on clean text returns original text
  const cleanResult = gitleaksScrub('clean message text from operator', cleanBin);
  assert.equal(cleanResult, 'clean message text from operator');

  // Leak detected: exit 1 returns null (message to be dropped)
  const leakResult = gitleaksScrub('message with leaked secret', leakBin);
  assert.equal(leakResult, null);

  // Scanner error (exit 2): fail closed
  assert.throws(() => gitleaksScrub('some text', errorBin), /gitleaks scan failed/);

  // Missing scanner binary: fail closed
  assert.throws(() => gitleaksScrub('some text', join(tmpDir, 'nonexistent')), /gitleaks scan failed/);

  // Integration with sampleDataset: exit 1 leak is dropped, exit 0 is included
  const candidates = [
    { text: 'clean text message 1', timestamp_utc: '2026-10-21T10:00:00Z' },
    { text: 'leak text message 2', timestamp_utc: '2026-10-21T11:00:00Z' }
  ];
  const scanWithMock = (text) => {
    return text.includes('leak') ? gitleaksScrub(text, leakBin) : gitleaksScrub(text, cleanBin);
  };
  const res = sampleDataset(candidates, { targetCount: 1, scan: scanWithMock });
  assert.equal(res.length, 1);
  assert.equal(res[0].text, 'clean text message 1');
});

test('parseSessionMessages filters isMeta, isSidechain, subagents, service wrappers and parses block arrays', () => {
  const jsonl = [
    // Standard user text
    JSON.stringify({ type: 'user', message: { text: 'Deploy the latest release to stage' }, timestamp: '2026-10-21T10:00:00Z' }),
    // isMeta = true -> skipped
    JSON.stringify({ type: 'user', isMeta: true, message: { text: 'Meta message to skip' }, timestamp: '2026-10-21T10:05:00Z' }),
    // isSidechain = true -> skipped
    JSON.stringify({ type: 'user', isSidechain: true, message: { text: 'Sidechain message to skip' }, timestamp: '2026-10-21T10:10:00Z' }),
    // subagent message -> skipped
    JSON.stringify({ type: 'user', subagent: true, message: { text: 'Subagent message to skip' }, timestamp: '2026-10-21T10:15:00Z' }),
    // array of text blocks
    JSON.stringify({
      role: 'user',
      content: [
        { type: 'text', text: 'Block array message part 1' },
        { type: 'text', text: 'part 2' }
      ],
      timestamp: '2026-10-21T10:20:00Z'
    }),
    // message containing tool_result block -> tool_result block excluded
    JSON.stringify({
      role: 'user',
      content: [
        { type: 'tool_result', content: 'Command exit status: 0' },
        { type: 'text', text: 'User text following tool result' }
      ],
      timestamp: '2026-10-21T10:25:00Z'
    }),
    // message containing ONLY tool_result -> skipped
    JSON.stringify({
      role: 'user',
      content: [
        { type: 'tool_result', content: 'Command exit status: 0' }
      ],
      timestamp: '2026-10-21T10:26:00Z'
    }),
    // service wrappers: <task-notification>, [OUT-OF-BAND...], <system>
    JSON.stringify({
      type: 'user',
      message: { text: '<task-notification>\nUpdate notification\n</task-notification>' },
      timestamp: '2026-10-21T10:30:00Z'
    }),
    JSON.stringify({
      type: 'user',
      message: { text: '[OUT-OF-BAND USER MESSAGE — direct]\nService wrapper only\n[/OUT-OF-BAND USER MESSAGE]' },
      timestamp: '2026-10-21T10:35:00Z'
    }),
    // Prompt wrapped in service tags -> wrapper stripped, prompt kept
    JSON.stringify({
      type: 'user',
      message: { text: '<system>System header</system>\nExecute deployment now' },
      timestamp: '2026-10-21T10:40:00Z'
    })
  ].join('\n');

  const parsed = parseSessionMessages(jsonl);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].text, 'Deploy the latest release to stage');
  assert.equal(parsed[0].timestamp_utc, '2026-10-21T10:00:00Z');
  assert.equal(parsed[1].text, 'Block array message part 1\npart 2');
  assert.equal(parsed[2].text, 'User text following tool result');
  assert.equal(parsed[3].text, 'Execute deployment now');
});

test('whitespace normalization, deduplication and output schema', () => {
  assert.equal(normalizeWhitespace('  hello \t  world \n \n test  '), 'hello world test');

  const candidates = [
    { text: '  Excessive   whitespace   \n\n  in   prompt   text  ', timestamp_utc: '2026-10-21T10:00:00Z' },
    { text: 'Excessive whitespace in prompt text', timestamp_utc: '2026-10-21T10:01:00Z' } // Duplicate after normalization
  ];
  const dataset = sampleDataset(candidates, { targetCount: 1, scan: text => text });
  assert.equal(dataset.length, 1);
  assert.equal(dataset[0].text, 'Excessive whitespace in prompt text');
  assert.equal(dataset[0].id, 1);
  assert.equal(dataset[0].timestamp_utc, '2026-10-21T10:00:00.000Z');
  assert.equal(dataset[0].scrubbed, true);
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
    targetCount: 50,
    scan: text => text
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

  assert.deepEqual(dataset.map(item => item.text), Array.from({ length: 50 }, (_, i) => `Test operational prompt #${i * 3} for task OPE-${1000 + i * 3}`));
  // Check uniform distribution / monotonic timestamps
  for (let i = 1; i < dataset.length; i++) {
    const prev = new Date(dataset[i - 1].timestamp_utc).getTime();
    const curr = new Date(dataset[i].timestamp_utc).getTime();
    assert.ok(curr >= prev, `Timestamps should be ordered: ${dataset[i - 1].timestamp_utc} <= ${dataset[i].timestamp_utc}`);
  }
});
