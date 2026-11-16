import test from 'node:test';
import assert from 'node:assert/strict';
import { planWork, dryRunWork } from './work-dry-run.mjs';

const fixture = () => ({
  fixture: 'work-offline/v1', source: 'source-company', target: 'work-company',
  entities: [
    { kind: 'project', id: 'p1', targetId: 'p-work' },
    { kind: 'issue', id: 'i1', targetId: 'i-work' },
    { kind: 'issue', id: 'i2', targetId: 'i-work' },
  ],
  relations: [{ from: 'issue:i1', to: 'project:p1' }, { from: 'issue:i2', to: 'agent:missing' }],
  bindings: [{ entity: 'issue:i1', name: 'tool', target: null }],
});

test('Work fixture reports mappings, relations, collisions, unknown sources, missing bindings and rollback order', () => {
  const plan = planWork(fixture());
  assert.equal(plan.mode, 'offline-fixture-only');
  assert.deepEqual([plan.source, plan.target], ['source-company', 'work-company']);
  assert.equal(plan.mappings.length, 3);
  assert.equal(plan.relations.length, 2);
  assert.deepEqual(plan.collisions, [{ kind: 'issue', targetId: 'i-work', sources: ['i1', 'i2'] }]);
  assert.deepEqual(plan.unknownSources, ['agent:missing']);
  assert.deepEqual(plan.missingBindings, [{ entity: 'issue:i1', name: 'tool' }]);
  assert.deepEqual(plan.rollback, ['stop-writes', 'revoke-capabilities', 'preserve-audit-and-checkpoints', 'restore-routing-and-memberships-from-snapshot', 'remove-provenance-rows-only', 'reconcile']);
  assert.equal(plan.ready, false);
});

test('dry run never invokes a transport, including mutating methods', async () => {
  const calls = [];
  const transport = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
  const plan = await dryRunWork(fixture(), transport);
  assert.equal(plan.mode, 'offline-fixture-only');
  assert.deepEqual(calls, []);
});

test('rejects unmarked or incomplete input rather than inventing mappings', () => {
  assert.throws(() => planWork({ ...fixture(), fixture: 'production' }), /fixture/);
  assert.throws(() => planWork({ ...fixture(), target: '' }), /target/);
  assert.throws(() => planWork({ ...fixture(), entities: [{ kind: 'issue', id: 'x' }] }), /targetId/);
  assert.throws(() => planWork({ ...fixture(), source: 'same', target: 'same' }), /different/);
});
