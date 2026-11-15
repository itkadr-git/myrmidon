import test from 'node:test';
import assert from 'node:assert/strict';
import { preflight } from './post-move-preflight.mjs';

const expected = {
  companyId: 'target-company', agentId: 'agent-1',
  bindings: ['TOKEN'], skills: ['review'], instructions: ['AGENTS.md'],
  memoryNamespace: 'target-company/agent-1',
};

function source(overrides = {}) {
  return {
    identity: async () => ({ companyId: 'target-company', agentId: 'agent-1' }),
    bindings: async () => [{ key: 'TOKEN', resolvable: true }],
    skills: async () => ['review'],
    instructions: async () => ['AGENTS.md'],
    memory: async () => ({ namespace: 'target-company/agent-1', accessible: true }),
    ...overrides,
  };
}

test('missing expected identity never passes', async () => {
  const malformed = { ...expected, companyId: '', agentId: '' };
  const result = await preflight(malformed, source({ identity: async () => ({ companyId: '', agentId: '' }) }));
  assert.equal(result.status, 'UNKNOWN');
});

test('valid target metadata passes', async () => {
  assert.equal((await preflight(expected, source())).status, 'PASS');
});

test('missing binding fails', async () => {
  assert.equal((await preflight(expected, source({ bindings: async () => [] }))).status, 'FAIL');
});

test('denied memory and unavailable sources cannot pass', async () => {
  assert.notEqual((await preflight(expected, source({ memory: async () => { throw new Error('denied'); } }))).status, 'PASS');
  assert.notEqual((await preflight(expected, source({ bindings: async () => { throw new Error('offline'); } }))).status, 'PASS');
});

test('skill mismatch and foreign namespace fail', async () => {
  assert.equal((await preflight(expected, source({ skills: async () => [] }))).status, 'FAIL');
  assert.equal((await preflight(expected, source({ memory: async () => ({ namespace: 'foreign', accessible: true }) }))).status, 'FAIL');
});

test('reports never include source values or errors', async () => {
  const sentinel = 'SENTINEL_SECRET_MEMORY';
  const report = await preflight(expected, source({ memory: async () => { throw new Error(sentinel); } }));
  assert.equal(JSON.stringify(report).includes(sentinel), false);
});
