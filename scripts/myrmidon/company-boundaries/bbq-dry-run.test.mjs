import test from 'node:test';
import assert from 'node:assert/strict';
import { dryRun, fixture } from './bbq-dry-run.mjs';

test('synthetic BBQ fixture reports relations, collisions, unknowns and rollback', () => {
  const report = dryRun(fixture);
  assert.deepEqual(report.relations, [{ from: 'project:shop', to: 'agent:bbq', kind: 'owner', status: 'resolved' }, { from: 'issue:task', to: 'agent:bbq', kind: 'owner', status: 'resolved' }, { from: 'issue:task', to: 'project:shop', kind: 'project', status: 'resolved' }]);
  assert.deepEqual(report.collisions, [{ kind: 'agent', key: 'bbq' }]);
  assert.ok(report.uncovered.some((item) => item.kind === 'memory'));
  assert.equal(report.rollback.available, false);
  assert.equal(report.fixture, 'synthetic');
});

test('missing owner is unknown, not attributed to BBQ', () => {
  const input = structuredClone(fixture);
  input.entities[1].owner = null;
  const report = dryRun(input);
  assert.ok(report.unknown.some((item) => item.entity === 'project:shop' && item.reason === 'missing owner'));
  assert.equal(report.ready, false);
});

test('repeat run is deterministic and does not mutate input', () => {
  const input = structuredClone(fixture);
  const before = structuredClone(input);
  assert.deepEqual(dryRun(input), dryRun(input));
  assert.deepEqual(input, before);
});

test('missing relation target is unknown', () => {
  const input = structuredClone(fixture);
  input.entities[2].project = 'missing';
  assert.ok(dryRun(input).unknown.some((item) => item.reason === 'missing project'));
});
