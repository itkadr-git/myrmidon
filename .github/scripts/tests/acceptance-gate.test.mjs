import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAcceptance } from '../acceptance-gate.mjs';

const base = 'a'.repeat(40), head = 'b'.repeat(40);
const pr = { title: 'OPE-42', body: '', base: { sha: base }, head: { sha: head } };
const document = JSON.stringify({ scenarios: [{ id: 'one', title: 'works', falsifiedWhen: 'broken' }] });
const options = (getDocument) => ({ pr, expectedBase: base, expectedHead: head, getDocument, reader: () => ({ ok: false }) });

test('transport errors fail closed', async () => {
  await assert.rejects(checkAcceptance(options(async () => { throw new Error('fetch failed'); })), /fetch failed/);
});
test('missing and malformed documents fail closed', async () => {
  await assert.rejects(checkAcceptance(options(async () => null)), /document/i);
  await assert.rejects(checkAcceptance(options(async () => '{')), /JSON/i);
  await assert.rejects(checkAcceptance(options(async () => JSON.stringify({ scenarios: 'bad' }))), /scenarios/i);
});
test('zero linked issues are explicitly skipped', async () => {
  const result = await checkAcceptance({ ...options(async () => { throw Error('unexpected'); }), pr: { ...pr, title: 'no issue' } });
  assert.deepEqual(result, { checked: 0, skipped: true });
});
test('every linked issue must have a verified document', async () => {
  await assert.rejects(checkAcceptance({ ...options(async (key) => key === 'OPE-42' ? document : null), pr: { ...pr, body: 'OPE-43' } }), /document/i);
});
test('valid document is counted', async () => {
  assert.deepEqual(await checkAcceptance(options(async () => document)), { checked: 1, skipped: false });
});
test('head and base are bound to the triggering event', async () => {
  await assert.rejects(checkAcceptance({ ...options(async () => document), expectedHead: 'c'.repeat(40) }), /head/i);
  await assert.rejects(checkAcceptance({ ...options(async () => document), expectedBase: 'c'.repeat(40) }), /base/i);
});
