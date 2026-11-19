import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audit } from './audit.mjs';

const base = () => ({ release: { version: '1.7.0', commits: ['abc'] }, issues: [{ id: 'I-1', status: 'done', kind: 'code', author: 'alice', mergedCommits: ['abc'], verification: { version: '1.7.0', method: 'manual', result: 'pass', verifier: 'bob' } }] });
const result = (input) => audit(input).issues[0];
test('exact release and independent evidence pass', () => { const r = result(base()); assert.equal(r.codeInRelease, 'yes'); assert.equal(r.verified, 'yes'); assert.equal(r.outcome, 'PASS'); });
test('absent commit never passes', () => { const x = base(); x.release.commits = []; const r = result(x); assert.equal(r.codeInRelease, 'no'); assert.notEqual(r.outcome, 'PASS'); });
test('stale version never passes', () => { const x = base(); x.issues[0].verification.version = '1.6.0'; assert.notEqual(result(x).outcome, 'PASS'); });
test('author cannot verify own work', () => { const x = base(); x.issues[0].verification.verifier = 'alice'; assert.notEqual(result(x).outcome, 'PASS'); });
test('non-code skip needs a reason', () => { const x = base(); x.issues[0] = { id: 'I-2', kind: 'non-code', skipReason: 'Documentation only' }; assert.equal(result(x).outcome, 'SKIPPED'); delete x.issues[0].skipReason; assert.equal(result(x).outcome, 'UNKNOWN'); });
test('done alone is unknown', () => { const x = base(); x.issues[0] = { id: 'I-3', status: 'done', kind: 'code' }; const r = result(x); assert.equal(r.outcome, 'UNKNOWN'); assert.equal(r.codeInRelease, 'unknown'); assert.equal(r.verified, 'unknown'); });
test('failed or incomplete evidence never passes', () => { const x = base(); x.issues[0].verification.result = 'fail'; assert.notEqual(result(x).outcome, 'PASS'); x.issues[0].verification.result = 'pass'; delete x.issues[0].verification.method; assert.equal(result(x).outcome, 'UNKNOWN'); });
test('missing release snapshot is unknown', () => { const x = base(); delete x.release.commits; assert.equal(result(x).outcome, 'UNKNOWN'); });
test('partial commit lists cannot pass', () => { const x = base(); x.issues[0].mergedCommits = ['abc', null]; assert.equal(result(x).outcome, 'UNKNOWN'); });
