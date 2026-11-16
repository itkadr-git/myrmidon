import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-dominators.mjs');
const sentinel = 'unique-portability-sentinel-7d43';
const target = 'target with spaces # (node)';
const report = {
  entry: 'entry',
  modules: [{ path: 'entry', bytes: 1, eager: true }, { path: target, bytes: 2, eager: true }],
  edges: [
    { from: 'entry', to: target, kind: 'eager', specifier: './target' },
    { from: 'entry', to: null, kind: 'lazy', specifier: sentinel },
  ],
};
const expected = JSON.stringify({ entry: 'entry', target, dominators: ['entry', target] }) + '\n';

function fixture(t) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'dom-portability-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd1 = join(root, 'cwd one'), cwd2 = join(root, 'cwd two');
  const inputs = join(root, `report ${sentinel} # (тест)`);
  for (const dir of [cwd1, cwd2, inputs]) mkdirSync(dir);
  const input = join(inputs, 'report.json'), dash = join(cwd1, '-report.json');
  const sidecar = join(inputs, 'sidecar.txt');
  const text = JSON.stringify(report);
  for (const file of [input, dash]) writeFileSync(file, text);
  writeFileSync(sidecar, sentinel);
  return { root, cwd1, cwd2, inputs, input, dash, sidecar, text };
}

function run(root, cwd, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
  });
}

function success(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, expected);
  assert.deepEqual(JSON.parse(result.stdout), { entry: 'entry', target, dominators: ['entry', target] });
}

test('foreign cwd and special paths preserve argv, output, and input files', t => {
  const f = fixture(t);
  const before = readdirSync(f.inputs).sort();
  const cwdBefore = readdirSync(f.cwd1).sort();
  for (const cwd of [f.cwd1, f.cwd2]) {
    for (const path of [f.input, relative(cwd, f.input)]) {
      success(run(f.root, cwd, path, target));
      success(run(f.root, cwd, path, target));
    }
  }
  success(run(f.root, f.cwd1, './-report.json', target));
  assert.equal(readFileSync(f.input, 'utf8'), f.text);
  assert.equal(readFileSync(f.dash, 'utf8'), f.text);
  assert.equal(readFileSync(f.sidecar, 'utf8'), sentinel);
  assert.deepEqual(readdirSync(f.inputs).sort(), before);
  assert.deepEqual(readdirSync(f.cwd1).sort(), cwdBefore);
});

test('foreign cwd errors are atomic and do not disclose input', t => {
  const f = fixture(t);
  const broken = join(f.inputs, 'broken.json'), shape = join(f.inputs, 'shape.json');
  const graph = join(f.inputs, 'graph.json');
  const brokenText = `{ "${sentinel}": `;
  const shapeText = JSON.stringify({ [sentinel]: sentinel });
  writeFileSync(broken, brokenText);
  writeFileSync(shape, shapeText);
  writeFileSync(graph, JSON.stringify({ ...report, entry: sentinel }));
  const cases = [
    [[], 'argv'], [[f.input], 'argv'], [[f.input, target, 'extra'], 'argv'],
    [[join(f.inputs, 'missing.json'), target], 'read'], [[f.inputs, target], 'read'],
    [[broken, target], 'json'], [[shape, target], 'shape'], [[graph, target], 'graph'],
  ];
  for (const cwd of [f.cwd1, f.cwd2]) for (const [args, category] of cases) {
    const result = run(f.root, cwd, ...args);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${category}\n`);
    for (const secret of [sentinel, f.root, brokenText, shapeText, 'Error:', ' at ']) {
      assert.equal(result.stderr.includes(secret), false);
    }
  }
});
