import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-lazy-boundaries.mjs', import.meta.url));
const m = (path, bytes, eager) => ({ path, bytes, eager });
const e = (from, specifier, kind, to) => ({ from, specifier, kind, to });

// Each oracle is written independently of the CLI output.
const cases = [
  {
    a: { entry: 'a/root', modules: [m('a/root', 1, true), m('a/core', 2, true), m('a/x', 11, false), m('a/y', 12, false)], edges: [e('a/root', './core', 'eager', 'a/core'), e('a/root', './alternate', 'lazy', 'a/core'), e('a/root', './x?raw', 'lazy', 'a/x'), e('a/core', '../y', 'lazy', 'a/y')] },
    b: { entry: 'b/root', modules: [m('b/root', 3, true), m('b/x', 21, false)], edges: [e('b/root', '@b/x', 'lazy', 'b/x')] },
    outA: '{"entry":"a/root","boundaries":[{"from":"a/core","specifier":"../y","to":"a/y","bytes":12},{"from":"a/root","specifier":"./x?raw","to":"a/x","bytes":11}]}\n',
    outB: '{"entry":"b/root","boundaries":[{"from":"b/root","specifier":"@b/x","to":"b/x","bytes":21}]}\n',
  },
  {
    a: { entry: 'c/main', modules: [m('c/main', 5, true), m('c/lazy', 31, false), m('c/deep', 32, false)], edges: [e('c/main', 'pkg/c', 'lazy', 'c/lazy'), e('c/lazy', './deep', 'lazy', 'c/deep')] },
    b: { entry: 'd/main', modules: [m('d/main', 7, true), m('d/one', 41, false), m('d/two', 42, false)], edges: [e('d/main', './two', 'lazy', 'd/two'), e('d/main', './one', 'lazy', 'd/one')] },
    outA: '{"entry":"c/main","boundaries":[{"from":"c/main","specifier":"pkg/c","to":"c/lazy","bytes":31}]}\n',
    outB: '{"entry":"d/main","boundaries":[{"from":"d/main","specifier":"./one","to":"d/one","bytes":41},{"from":"d/main","specifier":"./two","to":"d/two","bytes":42}]}\n',
  },
  {
    a: { entry: 'e/main', modules: [m('e/main', 8, true), m('e/core', 9, true)], edges: [e('e/main', './core', 'eager', 'e/core'), e('e/main', './same', 'lazy', 'e/core')] },
    b: { entry: 'f/main', modules: [m('f/main', 10, true), m('f/core', 13, true), m('f/leaf', 51, false)], edges: [e('f/main', './core', 'eager', 'f/core'), e('f/core', 'leaf#fragment', 'lazy', 'f/leaf')] },
    outA: '{"entry":"e/main","boundaries":[]}\n',
    outB: '{"entry":"f/main","boundaries":[{"from":"f/core","specifier":"leaf#fragment","to":"f/leaf","bytes":51}]}\n',
  },
];

function check(path, report, expected) {
  const input = JSON.stringify(report);
  writeFileSync(path, input);
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, [cli, path], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, expected);
    assert.equal(readFileSync(path, 'utf8'), input);
  }
}

for (const [index, { a, b, outA, outB }] of cases.entries()) {
  test(`disjoint startup graphs preserve each frontier: pair ${index + 1}`, () => {
    const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir(), 'disjoint-boundaries-'));
    try {
      const path = join(dir, 'report.json');
      check(path, a, outA);
      check(path, b, outB);
      for (const [root, other, expected] of [[a, b, outA], [b, a, outB]]) {
        const union = { entry: root.entry, modules: [...root.modules, ...other.modules.map(mod => ({ ...mod, eager: false }))], edges: [...root.edges, ...other.edges] };
        check(path, union, expected);
        check(path, { ...union, modules: [...union.modules].reverse(), edges: [...union.edges].reverse() }, expected);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('missing endpoint fails with sanitized graph category', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir(), 'disjoint-invalid-'));
  try {
    const path = join(dir, 'report.json');
    const report = { ...cases[0].a, edges: [...cases[0].a.edges, e('a/root', './missing', 'lazy', 'missing')] };
    const input = JSON.stringify(report);
    writeFileSync(path, input);
    const result = spawnSync(process.execPath, [cli, path], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'graph\n');
    assert.equal(readFileSync(path, 'utf8'), input);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
