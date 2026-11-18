import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const scanner = join(root, 'import-budget.mjs');
const summary = join(root, 'import-report-summary.mjs');
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || process.cwd();

const runScanner = entry => spawnSync(process.execPath, [scanner, entry], {
  cwd: join(scratch, '..'),
  encoding: 'utf8',
  timeout: 10000,
});
const runSummary = input => spawnSync(process.execPath, [summary], {
  input,
  cwd: join(scratch, '..'),
  encoding: 'utf8',
  timeout: 10000,
});
const bytes = source => Buffer.byteLength(source);
const markdown = report => {
  const lines = [
    '## Import report summary',
    '',
    'Static source bytes do not establish a performance win or verify production.',
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| modules | ${report.modules.length} |`,
    `| eagerModules | ${report.modules.filter(module => module.eager).length} |`,
    `| totalBytes | ${report.bytes.total} |`,
    `| eagerBytes | ${report.bytes.eager} |`,
    '',
    '### Top eager modules',
    '',
    '| Path | Bytes |',
    '| --- | ---: |',
  ];
  for (const module of report.modules.filter(module => module.eager).sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))) {
    lines.push(`| ${module.path} | ${module.bytes} |`);
  }
  lines.push('', '### Unresolved dependencies', '', '| Specifier | Kind | From |', '| --- | --- | --- |');
  for (const edge of report.unknown) lines.push(`| ${edge.specifier} | ${edge.kind} | ${edge.from} |`);
  lines.push('', 'Omitted: 0', '');
  return lines.join('\n');
};

function expectedReport(bridgeSource, leafSource) {
  const entrySource = "import './bridge.mjs';\n";
  const bridgeExists = bridgeSource !== null;
  const modules = bridgeExists
    ? [
        { path: 'bridge.mjs', bytes: bytes(bridgeSource), eager: true },
        { path: 'entry.mjs', bytes: bytes(entrySource), eager: true },
        { path: 'leaf.mjs', bytes: bytes(leafSource), eager: true },
      ]
    : [{ path: 'entry.mjs', bytes: bytes(entrySource), eager: true }];
  const edges = bridgeExists
    ? [
        { from: 'bridge.mjs', specifier: './leaf.mjs', kind: 'eager', to: 'leaf.mjs' },
        { from: 'entry.mjs', specifier: './bridge.mjs', kind: 'eager', to: 'bridge.mjs' },
      ]
    : [{ from: 'entry.mjs', specifier: './bridge.mjs', kind: 'eager', to: null }];
  return {
    entry: 'entry.mjs',
    modules,
    edges,
    unknown: edges.filter(edge => edge.to === null),
    counts: {
      modules: modules.length,
      eagerModules: modules.filter(module => module.eager).length,
      edges: edges.length,
    },
    bytes: {
      total: modules.reduce((total, module) => total + module.bytes, 0),
      eager: modules.reduce((total, module) => total + module.bytes, 0),
    },
    heaviestEager: [...modules].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)).slice(0, 10),
  };
}

function assertProcess(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, '');
  assert.notEqual(result.stdout, '');
}

test('reports physical source removal and exact recovery through the real scanner and summary consumer', () => {
  const dir = mkdtempSync(join(scratch, 'summary-removal-recovery-'));
  const entry = join(dir, 'entry.mjs');
  const bridge = join(dir, 'bridge.mjs');
  const leaf = join(dir, 'leaf.mjs');
  const sentinel = join(dir, 'sentinel');
  const entrySource = "import './bridge.mjs';\n";
  const bridgeSource = `import './leaf.mjs';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('source executed');\n`;
  const leafSource = `export const value = 'café';\n`;
  try {
    writeFileSync(entry, entrySource);
    writeFileSync(bridge, bridgeSource);
    writeFileSync(leaf, leafSource);
    const original = new Map([[entry, readFileSync(entry)], [bridge, readFileSync(bridge)], [leaf, readFileSync(leaf)]]);
    const baselineExpected = expectedReport(bridgeSource, leafSource);

    const baseline = runScanner(entry);
    assertProcess(baseline);
    assert.deepEqual(JSON.parse(baseline.stdout), baselineExpected);
    const baselineSummary = runSummary(baseline.stdout);
    assertProcess(baselineSummary);
    assert.equal(baselineSummary.stdout, markdown(baselineExpected));
    assert.equal(existsSync(sentinel), false);
    for (const [file, content] of original) assert.deepEqual(readFileSync(file), content);

    unlinkSync(bridge);
    const removedExpected = expectedReport(null, leafSource);
    const removed = runScanner(entry);
    assertProcess(removed);
    assert.deepEqual(JSON.parse(removed.stdout), removedExpected);
    assert.equal(removedExpected.modules.some(module => module.path === 'bridge.mjs'), false);
    assert.deepEqual(removedExpected.unknown, [{ from: 'entry.mjs', specifier: './bridge.mjs', kind: 'eager', to: null }]);
    assert.ok(removedExpected.bytes.total < baselineExpected.bytes.total);
    assert.ok(removedExpected.bytes.eager < baselineExpected.bytes.eager);
    const removedSummary = runSummary(removed.stdout);
    assertProcess(removedSummary);
    assert.equal(removedSummary.stdout, markdown(removedExpected));
    assert.match(removedSummary.stdout, /\| modules \| 1 \|/);
    assert.match(removedSummary.stdout, /\| \.\/bridge\.mjs \| eager \| entry\.mjs \|/);
    assert.doesNotMatch(removedSummary.stdout, /bridge\.mjs \| [0-9]+ \|/);
    assert.equal(existsSync(sentinel), false);
    assert.deepEqual(readFileSync(entry), original.get(entry));
    assert.deepEqual(readFileSync(leaf), original.get(leaf));
    assert.equal(existsSync(bridge), false);

    assert.throws(() => assert.deepEqual(JSON.parse(baseline.stdout), removedExpected));

    writeFileSync(bridge, original.get(bridge));
    const recovered = runScanner(entry);
    assertProcess(recovered);
    assert.deepEqual(JSON.parse(recovered.stdout), baselineExpected);
    assert.equal(recovered.stdout, baseline.stdout);
    const recoveredSummary = runSummary(recovered.stdout);
    assertProcess(recoveredSummary);
    assert.equal(recoveredSummary.stdout, baselineSummary.stdout);

    assert.equal(existsSync(sentinel), false);
    for (const [file, content] of original) assert.deepEqual(readFileSync(file), content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
