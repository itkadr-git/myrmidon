#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Accept opaque identifiers only: no commands, URLs, credentials or free text.
function reference(value) {
  return typeof value === 'string' && value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !/^(unknown|none|null|n\/?a|tbd)$/i.test(value) &&
    !/(password|secret|token|credential|private.?key)/i.test(value);
}

function object(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function generateRollbackPlan(m) {
  if (!object(m, ['version', 'changeId', 'owner', 'window', 'outOfBand', 'current', 'target', 'syntaxCheckRef', 'stopConditionRef']) ||
      m.version !== '1.7' ||
      !object(m.outOfBand, ['channelRef', 'verificationRef']) ||
      !object(m.current, ['routeRef', 'firewallRef', 'snapshotRef']) ||
      !object(m.target, ['routeRef', 'firewallRef']) ||
      ![m.changeId, m.owner, m.window, m.outOfBand.channelRef, m.outOfBand.verificationRef,
        m.current.routeRef, m.current.firewallRef, m.current.snapshotRef,
        m.target.routeRef, m.target.firewallRef, m.syntaxCheckRef, m.stopConditionRef].every(reference)) {
    throw new Error('Invalid manifest');
  }
  return `NOT EXECUTED - PLAN ONLY; ROLLBACK NOT VERIFIED
Change: ${m.changeId}
Window: ${m.window}
Owner: ${m.owner}
Prerequisite: independently verify out-of-band channel ${m.outOfBand.channelRef} using ${m.outOfBand.verificationRef} before proceeding.
Current route: ${m.current.routeRef}
Current firewall: ${m.current.firewallRef}
Target route: ${m.target.routeRef}
Target firewall: ${m.target.firewallRef}
Before change: operator checks syntax using ${m.syntaxCheckRef}.
Stop condition: ${m.stopConditionRef}; stop the change if triggered or any prerequisite is unknown.
Rollback: operator restores original snapshot ${m.current.snapshotRef} and independently verifies recovery.
No action has been performed; this plan is not proof of rollback readiness.
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected one JSON manifest path.');
    const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    process.stdout.write(generateRollbackPlan(input));
  } catch {
    process.stderr.write('Cannot generate plan: invalid or unreadable manifest. See rollback-plan README.\n');
    process.exitCode = 1;
  }
}
