import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = join(dir, 'import-report-cycles.mjs');
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME;
const sentinel = 'cycles-cli-portability-sentinel-7f3b';

function fixture(t) {
  const root = mkdtempSync(join(scratch, 'cycles-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwdA = join(root, 'foreign cwd A');
  const cwdB = join(root, 'foreign cwd B');
  const reportDir = join(root, 'report path # (отчёт)');
  const report = join(reportDir, 'report file (valid).json');
  const sidecar = join(reportDir, 'sidecar.sentinel');
  const valid = {
    entry: 'entry.mjs',
    marker: sentinel,
    modules: [
      { path: 'entry.mjs', bytes: 10, eager: true },
      { path: 'lazy.mjs', bytes: 20, eager: false },
    ],
    edges: [{ from: 'entry.mjs', specifier: './lazy.mjs', kind: 'lazy', to: null }],
  };
  for (const path of [cwdA, cwdB, reportDir]) mkdirSync(path);
  writeFileSync(report, JSON.stringify(valid));
  writeFileSync(sidecar, sentinel);
  return { root, cwd: [cwdA, cwdB], report, reportDir, sidecar, valid };
}

function run(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, TMPDIR: cwd },
    timeout: 10000,
  });
}

function state(fixture) {
  return {
    report: readFileSync(fixture.report),
    sidecar: readFileSync(fixture.sidecar),
    entries: readdirSync(fixture.reportDir),
    cwdEntries: fixture.cwd.map(path => readdirSync(path)),
    dashReport: readdirSync(fixture.cwd[1]).includes('-report.json')
      ? readFileSync(join(fixture.cwd[1], '-report.json')) : null,
  };
}

function assertProcessStarted(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
}

function assertSuccess(result, expected) {
  assertProcessStarted(result);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
}

function assertFailure(result, category, fixture) {
  assertProcessStarted(result);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `FAIL: ${category}\n`);
  assert.equal(result.stderr.includes(sentinel), false);
  assert.equal(result.stderr.includes(fixture.report), false);
  assert.equal(result.stderr.includes(JSON.stringify(fixture.valid)), false);
  assert.equal(result.stderr.includes(' at '), false);
  assert.equal(result.stderr.includes('Error'), false);
}

test('runs from foreign cwd with absolute and relative paths, including dash-prefixed basename', t => {
  const fixtureData = fixture(t);
  const expected = { entry: 'entry.mjs', eagerCycles: [], allCycles: [] };
  const absolute = fixtureData.report;
  const dashReport = join(fixtureData.cwd[1], '-report.json');
  writeFileSync(dashReport, readFileSync(fixtureData.report));

  for (const [cwd, path] of [
    [fixtureData.cwd[0], absolute],
    [fixtureData.cwd[0], relative(fixtureData.cwd[0], absolute)],
    [fixtureData.cwd[1], absolute],
    [fixtureData.cwd[1], relative(fixtureData.cwd[1], absolute)],
    [fixtureData.cwd[1], './-report.json'],
  ]) {
    const before = state(fixtureData);
    assertSuccess(run([path], cwd), expected);
    assert.deepEqual(state(fixtureData), before);
    assertSuccess(run([path], cwd), expected);
    assert.deepEqual(state(fixtureData), before);
  }
});

test('keeps the exact failure protocol and filesystem unchanged from foreign cwd', t => {
  const fixtureData = fixture(t);
  const validPath = fixtureData.report;
  const cases = [
    { args: [], category: 'arguments' },
    { args: [validPath, 'extra'], category: 'arguments' },
    { args: [join(fixtureData.root, `${sentinel}-missing.json`)], category: 'read' },
    { args: [fixtureData.reportDir], category: 'read' },
  ];
  cases.push({ args: [validPath], category: 'json', input: `{\"${sentinel}\":` });
  cases.push({ args: [validPath], category: 'shape', input: JSON.stringify({ marker: sentinel }) });

  for (const cwd of fixtureData.cwd) {
    for (const { args, category, input } of cases) {
      writeFileSync(validPath, input ?? JSON.stringify(fixtureData.valid));
      const before = state(fixtureData);
      assertFailure(run(args, cwd), category, fixtureData);
      assert.deepEqual(state(fixtureData), before);
    }
  }
});
