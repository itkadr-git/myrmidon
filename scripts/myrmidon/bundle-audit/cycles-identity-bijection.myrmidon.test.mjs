import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-cycles.mjs');
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || join(process.env.HOME, '.cache');
const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
const fixture = {
  entry: 'a',
  modules: names.map((path, i) => ({ path, bytes: i + 1, eager: i < 6 })),
  edges: [
    ['a', 'b', 'eager'], ['a', 'c', 'eager'], ['b', 'd', 'eager'], ['c', 'd', 'eager'],
    ['e', 'e', 'eager'], ['f', 'g', 'eager'], ['g', 'f', 'eager'],
    ['h', 'i', 'eager'], ['i', 'h', 'lazy'], ['d', null, 'lazy'],
  ].map(([from, to, kind], i) => ({ from, to, kind, specifier: `specifier-${i}` })),
};
// Independent graph oracle: diamond a-b/c-d; self-loop e; disconnected f-g;
// h-i closes only when lazy edges are included.
const expected = { entry: 'a', eagerCycles: [['e'], ['f', 'g']], allCycles: [['e'], ['f', 'g'], ['h', 'i']] };
const bijections = [
  ['z', 'y', 'x', 'w', 'v', 'u', 't', 's', 'r'],
  ['dir/z', 'dir/a', 'deep/z/x', 'deep/a/x', 'n/e', 'n/z', 'n/a', 'p/z', 'p/a'],
  ['\u03c9', '\u03b1', '\u00e9', '\u03b2', '\u0416', '\u00f1', '\u00e4', '\u4e2d', '\u65e5'],
];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canonical = groups => groups.map(group => [...group].sort(compare)).sort((a, b) => compare(a[0], b[0]));
function rename(report, map) {
  const id = value => value === null ? null : map.get(value);
  return { ...report, entry: id(report.entry), modules: report.modules.map(m => ({ ...m, path: id(m.path) })), edges: report.edges.map(e => ({ ...e, from: id(e.from), to: id(e.to) })) };
}
function translateOutput(output, map) {
  return { ...output, entry: map.get(output.entry), eagerCycles: canonical(output.eagerCycles.map(c => c.map(id => map.get(id)))), allCycles: canonical(output.allCycles.map(c => c.map(id => map.get(id)))) };
}
function run(input, file, stdin) {
  return spawnSync(process.execPath, [cli, stdin ? '-' : file], { encoding: 'utf8', input: stdin ? input : undefined, timeout: 10000 });
}

test('cycle identities survive three bijections in file and stdin modes', t => {
  const dir = mkdtempSync(join(scratch, 'cycles-bijection-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  const original = JSON.stringify(fixture);
  for (const targets of [names, ...bijections]) {
    assert.equal(new Set(targets).size, names.length);
    const forward = new Map(names.map((name, i) => [name, targets[i]]));
    const inverse = new Map(targets.map((name, i) => [name, names[i]]));
    const input = JSON.stringify(rename(fixture, forward));
    writeFileSync(file, input);
    const renamedExpected = translateOutput(expected, forward);
    for (const stdin of [false, true]) {
      const first = run(input, file, stdin);
      const repeat = run(input, file, stdin);
      for (const result of [first, repeat]) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        assert.equal(result.stdout, JSON.stringify(renamedExpected) + '\n');
        const output = JSON.parse(result.stdout);
        const restored = translateOutput(output, inverse);
        for (const key of ['eagerCycles', 'allCycles']) {
          assert.deepEqual(new Set(restored[key].map(c => JSON.stringify([...c].sort(compare)))), new Set(expected[key].map(c => JSON.stringify(c))));
        }
        assert.deepEqual(restored, expected);
      }
      assert.equal(first.stdout, repeat.stdout);
    }
    assert.equal(readFileSync(file, 'utf8'), input);
  }
  assert.equal(JSON.stringify(fixture), original);
});

test('a collision is rejected rather than treated as a bijection', t => {
  const dir = mkdtempSync(join(scratch, 'cycles-collision-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  const targets = [...names]; targets[1] = targets[0];
  const input = JSON.stringify(rename(fixture, new Map(names.map((name, i) => [name, targets[i]]))));
  writeFileSync(file, input);
  for (const stdin of [false, true]) {
    const result = run(input, file, stdin);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'FAIL: duplicate\n');
  }
});
