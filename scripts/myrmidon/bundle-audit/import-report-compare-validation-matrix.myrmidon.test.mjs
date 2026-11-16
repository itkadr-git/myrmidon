import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-compare.mjs', import.meta.url));
const fixture = () => ({
  entry: 'entry.mjs', modules: [{ path: 'a', bytes: 2, eager: true }],
  counts: { modules: 1, eagerModules: 1 }, bytes: { total: 2, eager: 2 },
});

function runner(t) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'compare-matrix-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return (base, current) => {
    const paths = [join(dir, 'base.json'), join(dir, 'current.json')];
    writeFileSync(paths[0], JSON.stringify(base));
    writeFileSync(paths[1], JSON.stringify(current));
    return spawnSync(process.execPath, [cli, ...paths], { encoding: 'utf8', timeout: 10000 });
  };
}

function rejected(result, category) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${category}\n`);
}

function accepted(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expected);
}

const zero = { entry: 'entry.mjs', delta: { modules: 0, eagerModules: 0, totalBytes: 0, eagerBytes: 0 }, added: [], removed: [], changed: [] };

test('totals validation matrix rejects each malformed field on either side', t => {
  const run = runner(t);
  const fields = [['counts', 'modules', 1], ['counts', 'eagerModules', 1], ['bytes', 'total', 2], ['bytes', 'eager', 2]];
  const cases = [['missing', undefined], ['null', null], ['boolean', true], ['numeric string', '1'], ['fractional', 1.5], ['unsafe', Number.MAX_SAFE_INTEGER + 1]];
  for (const side of [0, 1]) for (const [group, field, correct] of fields) {
    for (const [name, value] of [...cases, ['off-by-one', correct + 1]]) {
      const reports = [fixture(), fixture()];
      if (name === 'missing') delete reports[side][group][field];
      else reports[side][group][field] = value;
      const result = run(...reports);
      assert.doesNotThrow(() => rejected(result, 'invalid totals'), `${side} ${group}.${field} ${name}`);
    }
  }
});

test('module failures precede invalid totals and never emit a partial delta', t => {
  const run = runner(t);
  const cases = [
    ['duplicate module', [{ path: 'a', bytes: 2, eager: true }, { path: 'a', bytes: 2, eager: true }]],
    ['invalid module', [{ path: 'a', bytes: 2, eager: true }, { path: 'b', bytes: '1', eager: true }]],
  ];
  for (const side of [0, 1]) for (const [category, modules] of cases) {
    const reports = [fixture(), fixture()];
    reports[side].modules = modules;
    rejected(run(...reports), category);
  }
});

test('overflowing module sums are rejected even when declared totals agree', t => {
  const run = runner(t);
  for (const side of [0, 1]) {
    const reports = [fixture(), fixture()];
    reports[side] = {
      entry: 'entry.mjs',
      modules: [{ path: 'a', bytes: Number.MAX_SAFE_INTEGER, eager: true }, { path: 'b', bytes: 1, eager: false }],
      counts: { modules: 2, eagerModules: 1 },
      bytes: { total: Number.MAX_SAFE_INTEGER + 1, eager: Number.MAX_SAFE_INTEGER },
    };
    rejected(run(...reports), 'invalid totals');
  }
});

test('extra totals fields and maximum safe totals are accepted on either side', t => {
  const run = runner(t);
  for (const side of [0, 1]) {
    const extra = [fixture(), fixture()];
    extra[side].counts.extra = 'allowed';
    extra[side].bytes.extra = 'allowed';
    accepted(run(...extra), zero);
    const max = [fixture(), fixture()];
    max[side] = { entry: 'entry.mjs', modules: [{ path: 'a', bytes: Number.MAX_SAFE_INTEGER, eager: true }], counts: { modules: 1, eagerModules: 1 }, bytes: { total: Number.MAX_SAFE_INTEGER, eager: Number.MAX_SAFE_INTEGER } };
    const difference = Number.MAX_SAFE_INTEGER - 2;
    accepted(run(...max), { entry: 'entry.mjs', delta: { modules: 0, eagerModules: 0, totalBytes: side ? difference : -difference, eagerBytes: side ? difference : -difference }, added: [], removed: [], changed: [{ path: 'a', before: { bytes: max[0].modules[0].bytes, eager: true }, after: { bytes: max[1].modules[0].bytes, eager: true } }] });
  }
});
