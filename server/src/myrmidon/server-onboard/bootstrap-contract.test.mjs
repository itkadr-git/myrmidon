import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetOnboardExecutor } from './executor.ts';

function fixture(step, role = 'generic', deps = {}) {
  const events = [];
  const ssh = { connect: async () => {}, disconnect: async () => {}, execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }) };
  const executor = new FleetOnboardExecutor({ createSshExecutor: () => ssh, ...deps });
  const claim = { job: { id: 'j', companyId: 'c', serverId: 's', kind: 'onboard' }, server: { hostname: 'host', port: 22, username: 'root' }, steps: [step], options: { keepPassword: true, role }, secretValues: { accessKey: 'key' } };
  const reporter = { reportStep: async (...args) => events.push(args), reportCompletion: async () => {} };
  return { executor, claim, reporter, events };
}

test('monitoring is skipped only when explicitly configured', async () => {
  const missing = fixture('monitoring');
  assert.equal((await missing.executor.execute(missing.claim, missing.reporter)).status, 'failed');
  const skipped = fixture('monitoring', 'generic', { skipMonitoring: true });
  assert.equal((await skipped.executor.execute(skipped.claim, skipped.reporter)).status, 'succeeded');
  assert.equal(skipped.events[0][1], 'skipped');
});

test('unimplemented roles never report successful bootstrap', async () => {
  for (const role of ['build-runner', 'sandbox', 'bot-host', 'unknown']) {
    const f = fixture('role', role);
    assert.equal((await f.executor.execute(f.claim, f.reporter)).status, 'failed', role);
    assert.equal(f.events[0][1], 'failed');
  }
});

test('generic role reports an honest skip', async () => {
  const f = fixture('role');
  assert.equal((await f.executor.execute(f.claim, f.reporter)).status, 'succeeded');
  assert.equal(f.events[0][1], 'skipped');
});
