import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRollbackPlan } from './rollback-plan.mjs';

const manifest = {
  version: '1.7', changeId: 'change-001', owner: 'operator-001', window: 'window-001',
  outOfBand: { channelRef: 'console-001', verificationRef: 'check-001' },
  current: { routeRef: 'route-old', firewallRef: 'firewall-old', snapshotRef: 'snapshot-old' },
  target: { routeRef: 'route-new', firewallRef: 'firewall-new' },
  syntaxCheckRef: 'syntax-check-001', stopConditionRef: 'stop-condition-001',
};

test('renders an explicit non-executable operator plan', () => {
  const output = generateRollbackPlan(manifest);
  assert.equal(output, `NOT EXECUTED - PLAN ONLY; ROLLBACK NOT VERIFIED
Change: change-001
Window: window-001
Owner: operator-001
Prerequisite: independently verify out-of-band channel console-001 using check-001 before proceeding.
Current route: route-old
Current firewall: firewall-old
Target route: route-new
Target firewall: firewall-new
Before change: operator checks syntax using syntax-check-001.
Stop condition: stop-condition-001; stop the change if triggered or any prerequisite is unknown.
Rollback: operator restores original snapshot snapshot-old and independently verifies recovery.
No action has been performed; this plan is not proof of rollback readiness.
`);
});

test('rejects missing snapshot, owner, independent access, or required refs', () => {
  for (const path of ['current.snapshotRef', 'owner', 'outOfBand.channelRef', 'outOfBand.verificationRef', 'current.routeRef', 'target.firewallRef', 'syntaxCheckRef', 'stopConditionRef']) {
    const bad = structuredClone(manifest);
    const parts = path.split('.');
    if (parts.length === 1) delete bad[parts[0]];
    else delete bad[parts[0]][parts[1]];
    assert.throws(() => generateRollbackPlan(bad), /invalid manifest/i, path);
  }
});

test('rejects secrets, unknown placeholders, extra fields and release 1.8', () => {
  for (const bad of [
    { ...manifest, password: 'secret-value' },
    { ...manifest, owner: 'unknown' },
    { ...manifest, owner: 'token=secret-value' },
    { ...manifest, version: '1.8' },
  ]) assert.throws(() => generateRollbackPlan(bad), /invalid manifest/i);
});
