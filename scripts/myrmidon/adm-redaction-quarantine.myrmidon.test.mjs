import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMigration, redactSecrets } from './adm-migrate.mjs';

const marker = 'synthetic-marker-one';
const other = 'synthetic-marker-two';
const quarantine = '<!-- QUARANTINED: sensitive content detected by gitleaks failed safe redaction -->\n';
const clean = { clean: true, findings: [] };

function fakeScannerPort(...responses) {
  const inputs = [];
  return {
    inputs,
    scan(text) {
      inputs.push(text);
      assert.ok(responses.length, 'unexpected scanner call');
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function finding(secret) {
  return { Secret: secret };
}

function dirty(...findings) {
  return { clean: false, findings };
}

test('clean input is unchanged and scanned once', () => {
  const port = fakeScannerPort(clean);
  assert.deepEqual(redactSecrets('ordinary text', port.scan), { redacted: 'ordinary text', findings: [] });
  assert.deepEqual(port.inputs, ['ordinary text']);
});

test('empty clean input is unchanged', () => {
  const port = fakeScannerPort(clean);
  assert.deepEqual(redactSecrets('', port.scan), { redacted: '', findings: [] });
  assert.deepEqual(port.inputs, ['']);
});

test('repeated marker is replaced everywhere and rescanned', () => {
  const port = fakeScannerPort(dirty(finding(marker)), clean);
  const result = redactSecrets(`${marker} / ${marker}`, port.scan);
  assert.equal(result.redacted, '[REDACTED_SECRET] / [REDACTED_SECRET]');
  assert.deepEqual(port.inputs, [`${marker} / ${marker}`, result.redacted]);
  assert.deepEqual(result.findings, [finding(marker)]);
  assert.equal(result.secretsRemaining, 0);
});

test('distinct findings are both redacted before rescan', () => {
  const port = fakeScannerPort(dirty(finding(marker), finding(other)), clean);
  const result = redactSecrets(`${marker} and ${other}`, port.scan);
  assert.equal(result.redacted, '[REDACTED_SECRET] and [REDACTED_SECRET]');
  assert.equal(port.inputs[1], result.redacted);
  assert.equal(result.findings.length, 2);
});

test('redaction treats special characters literally', () => {
  const secret = 'synthetic.$[marker]*';
  const port = fakeScannerPort(dirty(finding(secret)), clean);
  assert.equal(redactSecrets(`x ${secret} y`, port.scan).redacted, 'x [REDACTED_SECRET] y');
  assert.deepEqual(port.inputs, [`x ${secret} y`, 'x [REDACTED_SECRET] y']);
});

test('missing Secret and dirty rescan quarantine the entire input', () => {
  const port = fakeScannerPort(dirty({ RuleID: 'synthetic' }), dirty(finding(marker)));
  const result = redactSecrets(`private ${marker}`, port.scan);
  assert.equal(result.redacted, quarantine);
  assert.equal(result.quarantined, true);
  assert.equal(result.secretsRemaining, 1);
  assert.deepEqual(port.inputs, [`private ${marker}`, `private ${marker}`]);
});

test('empty Secret and dirty rescan quarantine the input', () => {
  const port = fakeScannerPort(dirty(finding('')), dirty(finding(marker)));
  const result = redactSecrets(marker, port.scan);
  assert.equal(result.redacted, quarantine);
  assert.equal(result.secretsRemaining, 1);
  assert.deepEqual(port.inputs, [marker, marker]);
});

test('dirty rescan quarantines even after a successful replacement', () => {
  const port = fakeScannerPort(dirty(finding(marker)), dirty(finding(other), finding('third')));
  const result = redactSecrets(`${marker} ${other}`, port.scan);
  assert.equal(result.redacted, quarantine);
  assert.equal(result.quarantined, true);
  assert.equal(result.secretsRemaining, 2);
  assert.deepEqual(port.inputs, [`${marker} ${other}`, `[REDACTED_SECRET] ${other}`]);
});

test('dirty rescan without findings reports zero remaining and quarantines', () => {
  const port = fakeScannerPort(dirty(finding(marker)), { clean: false });
  const result = redactSecrets(marker, port.scan);
  assert.equal(result.redacted, quarantine);
  assert.equal(result.quarantined, true);
  assert.equal(result.secretsRemaining, 0);
});

test('initial scanner error propagates unchanged', () => {
  const failure = new Error('synthetic initial failure');
  const port = fakeScannerPort(failure);
  assert.throws(() => redactSecrets(marker, port.scan), (error) => error === failure);
  assert.deepEqual(port.inputs, [marker]);
});

test('rescan error propagates unchanged', () => {
  const failure = new Error('synthetic rescan failure');
  const port = fakeScannerPort(dirty(finding(marker)), failure);
  assert.throws(() => redactSecrets(marker, port.scan), (error) => error === failure);
  assert.deepEqual(port.inputs, [marker, '[REDACTED_SECRET]']);
});

test('migration reports only redaction metadata and excludes marker from items', () => {
  const root = mkdtempSync(join(tmpdir(), 'adm-redaction-contract-'));
  try {
    mkdirSync(join(root, 'memory'));
    writeFileSync(join(root, 'memory', 'MEMORY.md'), '# Policies\n- [Safety](safety.md)\n');
    writeFileSync(join(root, 'CLAUDE.md'), '---\ndescription: Operations\n---\n# Operations\nSafe.\n');
    writeFileSync(join(root, 'memory', 'safety.md'), `---\ndescription: Safety\n---\n# Safety\n${marker}\n`);
    const port = fakeScannerPort(clean, dirty(finding(marker)), clean);
    const { items, report } = buildMigration(root, { scan: port.scan });
    assert.deepEqual(report.redactions, [{ path: 'memory/safety.md', findings: 1, quarantined: false }]);
    assert.equal(JSON.stringify(report.redactions).includes(marker), false);
    assert.equal(items.find((item) => item.path === 'memory/safety.md').body.includes(marker), false);
    assert.match(items.find((item) => item.path === 'memory/safety.md').body, /\[REDACTED_SECRET\]/);
    assert.equal(port.inputs.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migration reports quarantine and rescan count without leaking marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'adm-quarantine-contract-'));
  try {
    mkdirSync(join(root, 'memory'));
    writeFileSync(join(root, 'memory', 'MEMORY.md'), '# Policies\n- [Safety](safety.md)\n');
    writeFileSync(join(root, 'CLAUDE.md'), '---\ndescription: Operations\n---\n# Operations\nSafe.\n');
    writeFileSync(join(root, 'memory', 'safety.md'), `# Safety\n${marker}\n`);
    const port = fakeScannerPort(clean, dirty({ RuleID: 'synthetic' }), dirty(finding(marker), finding(other)));
    const { items, report } = buildMigration(root, { scan: port.scan });
    assert.deepEqual(report.redactions, [{ path: 'memory/safety.md', findings: 1, quarantined: true }]);
    assert.equal(report.secretsRemaining, 2);
    assert.equal(items.find((item) => item.path === 'memory/safety.md').body, quarantine);
    assert.equal(JSON.stringify(report.redactions).includes(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
