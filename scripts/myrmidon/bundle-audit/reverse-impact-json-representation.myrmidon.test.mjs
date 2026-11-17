import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-reverse-impact.mjs', import.meta.url);
const target = 'src/\u{1f680}.js';
const mod = path => ({ path, bytes: 2, eager: true });
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: to });
const report = {
  entry: 'src/entry.js',
  modules: ['src/entry.js', 'src/a.js', 'src/b.js', target, 'src/lazy.js'].map(mod),
  edges: [
    edge('src/entry.js', 'src/a.js'), edge('src/entry.js', 'src/b.js'),
    edge('src/b.js', target), edge('src/a.js', target),
    edge(target, 'src/a.js'), edge('src/entry.js', 'src/lazy.js'),
    edge('src/lazy.js', target, 'lazy'),
  ],
};
const expected = '{"entry":"src/entry.js","target":"src/🚀.js","importers":[{"path":"src/a.js","distance":1},{"path":"src/b.js","distance":1},{"path":"src/entry.js","distance":2}]}\n';
const compact = JSON.stringify(report);
const escaped = compact.replace('"entry"', '"\\u0065ntry"')
  .replaceAll('/', '\\/').replaceAll('🚀', '\\ud83d\\ude80');
const representations = [
  compact,
  ` \r\n\t${JSON.stringify(report, null, 2).replaceAll('\n', '\r\n')}\r\n `,
  escaped.replaceAll('"bytes":2', '"bytes":2.0'),
  compact.replaceAll('"bytes":2', '"bytes":2e0'),
  compact,
];

function run(input, file, useStdin) {
  return spawnSync(process.execPath, [cli.pathname, useStdin ? '-' : file, target], {
    encoding: 'utf8', input: useStdin ? input : undefined, timeout: 5000,
  });
}

test('equivalent JSON representations preserve diamond and cycle reverse impact', t => {
  const root = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'reverse-impact-json-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  for (const input of representations) {
    assert.deepEqual(JSON.parse(input), report);
    writeFileSync(file, input);
    const before = readFileSync(file);
    for (const stdin of [false, true]) {
      const result = run(input, file, stdin);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, expected);
      assert.deepEqual(readFileSync(file), before);
    }
  }
  const changed = structuredClone(report);
  changed.edges = changed.edges.filter(e => !(e.from === 'src/b.js' && e.to === target));
  const input = JSON.stringify(changed);
  writeFileSync(file, input);
  const before = readFileSync(file);
  for (const stdin of [false, true]) {
    const result = run(input, file, stdin);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, '{"entry":"src/entry.js","target":"src/🚀.js","importers":[{"path":"src/a.js","distance":1},{"path":"src/entry.js","distance":2}]}\n');
    assert.deepEqual(readFileSync(file), before);
  }
});

test('unescaped control character fails closed without disclosing input', t => {
  const root = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'reverse-impact-invalid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  const input = '{"marker":"DO_NOT_REFLECT\u0001"}';
  writeFileSync(file, input);
  const before = readFileSync(file);
  for (const stdin of [false, true]) {
    const result = run(input, file, stdin);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /DO_NOT_REFLECT/);
    assert.deepEqual(readFileSync(file), before);
  }
});
