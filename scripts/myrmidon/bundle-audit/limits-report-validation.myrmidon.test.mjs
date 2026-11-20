import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-limits.mjs', import.meta.url));
const args = ['--max-eager-bytes', '100', '--max-eager-modules', '10'];
const fixture = () => ({
  modules: [{ path: 'entry', bytes: 5, eager: true }, { path: 'lazy', bytes: 7, eager: false }],
  counts: { eagerModules: 1 },
  bytes: { eager: 5 },
});
const run = report => spawnSync(process.execPath, [cli, ...args], {
  input: JSON.stringify(report), encoding: 'utf8', timeout: 10000,
});
const rejected = (report, label) => {
  const result = run(report);
  assert.equal(result.status, 2, `${label}: status; stderr=${result.stderr}`);
  assert.equal(result.stdout, '', `${label}: stdout`);
  assert.equal(result.stderr, 'report error\n', `${label}: stderr`);
};

test('missing, null and wrong-type report fields fail closed', () => {
  const fields = [
    ['modules', r => r, 'modules', {}],
    ['counts.eagerModules', r => r.counts, 'eagerModules', '1'],
    ['bytes.eager', r => r.bytes, 'eager', '5'],
    ['path', r => r.modules[0], 'path', 12],
    ['bytes', r => r.modules[0], 'bytes', '5'],
    ['eager', r => r.modules[0], 'eager', 'true'],
  ];
  for (const [name, parent, key, wrong] of fields) {
    for (const [variant, value] of [['missing', undefined], ['null', null], ['wrong type', wrong]]) {
      const report = fixture();
      if (variant === 'missing') delete parent(report)[key];
      else parent(report)[key] = value;
      rejected(report, `${name}: ${variant}`);
    }
  }
});

test('duplicate and empty module paths fail closed', () => {
  for (const path of ['entry', '']) {
    const report = fixture();
    report.modules[1].path = path;
    rejected(report, `path ${JSON.stringify(path)}`);
  }
});

test('invalid byte values fail closed even for non-eager modules', () => {
  for (const eager of [true, false]) {
    for (const bytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const report = fixture();
      report.modules[eager ? 0 : 1].bytes = bytes;
      rejected(report, `eager=${eager}, bytes=${bytes}`);
    }
  }
});

test('forged eager byte and module aggregates fail closed', () => {
  const forgedBytes = fixture();
  forgedBytes.bytes.eager = 6;
  rejected(forgedBytes, 'forged eager bytes');
  const forgedCount = fixture();
  forgedCount.counts.eagerModules = 2;
  rejected(forgedCount, 'forged eager module count');
});

test('zero-byte eager module and largest safe lazy module are valid', () => {
  const report = {
    modules: [{ path: 'zero', bytes: 0, eager: true }, { path: 'large-lazy', bytes: Number.MAX_SAFE_INTEGER, eager: false }],
    counts: { eagerModules: 1 }, bytes: { eager: 0 },
  };
  const result = run(report);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '{"ok":true,"eagerBytes":0,"eagerModules":1,"maxEagerBytes":100,"maxEagerModules":10,"violations":[]}\n');
});
