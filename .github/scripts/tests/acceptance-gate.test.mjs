import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAcceptance, documentBody, fetchJson } from '../acceptance-gate.mjs';

test('document revision is recorded without logging document content', () => {
  const lines = [];
  assert.equal(documentBody('OPE-42', { body: 'private content', id: 'document-id', latestRevisionId: 'revision-id' }, (line) => lines.push(line)), 'private content');
  assert.deepEqual(lines, ['OPE-42: document=document-id revision=revision-id (snapshot; later edits require rerun)']);
  assert.throws(() => documentBody('OPE-42', { body: 'private content' }, () => {}), /revision/i);
});

const base = 'a'.repeat(40), head = 'b'.repeat(40);
const pr = { title: 'OPE-42', body: '', base: { sha: base }, head: { sha: head } };
const document = JSON.stringify({ scenarios: [{ id: 'one', title: 'works', falsifiedWhen: 'broken' }] });
const options = (getDocument) => ({ pr, expectedBase: base, expectedHead: head, expectedTitle: pr.title, expectedBody: pr.body, getDocument, reader: () => ({ ok: false }) });

test('transport errors fail closed', async () => {
  await assert.rejects(checkAcceptance(options(async () => { throw new Error('fetch failed'); })), /fetch failed/);
});
test('missing and malformed documents fail closed', async () => {
  await assert.rejects(checkAcceptance(options(async () => null)), /document/i);
  await assert.rejects(checkAcceptance(options(async () => '{')), /JSON/i);
  await assert.rejects(checkAcceptance(options(async () => JSON.stringify({ scenarios: 'bad' }))), /scenarios/i);
  await assert.rejects(checkAcceptance(options(async () => JSON.stringify({ scenarios: [] }))), /zero scenarios/i);
});
test('zero linked issues are explicitly skipped', async () => {
  const result = await checkAcceptance({ ...options(async () => { throw Error('unexpected'); }), pr: { ...pr, title: 'no issue' }, expectedTitle: 'no issue' });
  assert.deepEqual(result, { checked: 0, skipped: true });
});
test('every linked issue must have a verified document', async () => {
  await assert.rejects(checkAcceptance({ ...options(async (key) => key === 'OPE-42' ? document : null), pr: { ...pr, body: 'OPE-43' }, expectedBody: 'OPE-43' }), /document/i);
});
test('valid document is counted', async () => {
  assert.deepEqual(await checkAcceptance(options(async () => document)), { checked: 1, skipped: false });
});
test('head and base are bound to the triggering event', async () => {
  await assert.rejects(checkAcceptance({ ...options(async () => document), expectedHead: 'c'.repeat(40) }), /head/i);
  await assert.rejects(checkAcceptance({ ...options(async () => document), expectedBase: 'c'.repeat(40) }), /base/i);
});
test('non-HTTPS API URL is rejected before any network request and never carries credentials', async () => {
  const calls = [];
  const seenHeaders = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => {
    calls.push(String(url));
    seenHeaders.push(init.headers ?? {});
    return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  };
  try {
    for (const url of ['http://127.0.0.1:3100/api/issues/OPE-42', 'http://localhost:3100/api', 'http://[::1]:3100/api', 'http://internal.host/api', 'ftp://example.com/api']) {
      await assert.rejects(fetchJson(url, 'secret-token'), /https/i);
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls.length, 0, 'no HTTP request may be performed for a non-HTTPS URL');
  assert.equal(seenHeaders.length, 0, 'Authorization must never be attached to a non-HTTPS request');
});
test('HTTPS API request still sends Authorization and parses JSON', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers });
    return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  };
  try {
    assert.deepEqual(await fetchJson('https://board.internal/api/issues/OPE-42', 'secret-token'), { ok: true });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:/);
  assert.equal(calls[0].headers.Authorization, 'Bearer secret-token');
});
test('missing event title/body binding fails closed', async () => {
  await assert.rejects(checkAcceptance({ ...options(async () => document), expectedTitle: undefined }), /title\/body binding/i);
  await assert.rejects(checkAcceptance({ ...options(async () => document), expectedBody: undefined }), /title\/body binding/i);
});
test('stale edited event fails closed before any document is verified', async () => {
  const verified = [];
  const newer = { ...pr, title: 'OPE-43' };
  await assert.rejects(checkAcceptance({ ...options(async (key) => { verified.push(key); return document; }), pr: newer, expectedTitle: 'OPE-42', expectedBody: '' }), /stale event/i);
  assert.deepEqual(verified, [], 'a stale run must not verify any document snapshot');
});
test('overlapping edited runs are bound to their own event data', async () => {
  const verified = [];
  const live = { ...pr, title: 'OPE-42 OPE-43', body: '' };
  await assert.rejects(checkAcceptance({ ...options(async (key) => { verified.push(key); return document; }), pr: live, expectedTitle: 'OPE-42', expectedBody: '' }), /stale event/i);
  assert.deepEqual(verified, [], 'run must not follow a newer title/body snapshot than its own event');
  const matching = await checkAcceptance({ ...options(async (key) => { verified.push(key); return document; }), pr: live, expectedTitle: 'OPE-42 OPE-43', expectedBody: '' });
  assert.equal(matching.checked, 2);
  assert.deepEqual(verified, ['OPE-42', 'OPE-43']);
});
