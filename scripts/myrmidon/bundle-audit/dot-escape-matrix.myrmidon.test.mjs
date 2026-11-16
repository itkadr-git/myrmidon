import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-dot.mjs', import.meta.url));
const run = report => spawnSync(process.execPath, [cli], {
  input: JSON.stringify(report), encoding: 'utf8', timeout: 5000,
});
const moduleOf = path => ({ path, bytes: 0, eager: true });
const edge = (from, specifier, to) => ({ from, specifier, kind: 'eager', to });
const escapes = new Map([['"', '\\"'], ['\\', '\\\\'], ['\n', '\\n'], ['\r', '\\n'], ['\t', '\\t']]);
const literal = value => `"${Array.from(value, char => escapes.get(char) ?? char).join('')}"`;
const cases = [
  ['quote', '"'], ['backslash', '\\'], ['LF', '\n'], ['CR', '\r'], ['tab', '\t'],
  ['Unicode', '\u96ea\ud83d\ude80'], ['literal backslash-n', '\\n'], ['real LF', '\n'],
  ['combined', '\\n\n\r\t"\\'], ['DOT and shell syntax', '"]; evil [label="$(touch nope)`x`; //'],
];

function success(report, expected) {
  const result = run(report);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, expected);
}

test('path labels escape each literal independently without extra statements', () => {
  for (const [name, value] of cases) {
    const path = `path-${value}`;
    const expected = `digraph imports {\n  n0 [label=${literal(path)}, style=solid];\n  // unresolved: 0\n}\n`;
    success({ entry: path, modules: [moduleOf(path)], edges: [] }, expected);
  }
});

test('specifier labels escape each literal independently, including empty', () => {
  for (const [name, value] of [...cases, ['empty', '']]) {
    const expected = `digraph imports {\n  n0 [label="a", style=solid];\n  n0 -> n0 [label=${literal(value)}, style=solid];\n  // unresolved: 0\n}\n`;
    success({ entry: 'a', modules: [moduleOf('a')], edges: [edge('a', value, 'a')] }, expected);
  }
});

test('CR and LF paths retain distinct node ids despite identical displayed labels', () => {
  const cr = 'x\r', lf = 'x\n';
  success({ entry: cr, modules: [moduleOf(cr), moduleOf(lf)], edges: [edge(cr, 'link', lf)] },
    'digraph imports {\n  n0 [label="x\\n", style=solid];\n  n1 [label="x\\n", style=solid];\n  n1 -> n0 [label="link", style=solid];\n  // unresolved: 0\n}\n');
});

test('disallowed C0 and DEL fail shape in each path and specifier position', () => {
  const controls = [...Array(32).keys()].filter(code => ![9, 10, 13].includes(code)).concat(127);
  for (const code of controls) {
    const value = `x${String.fromCharCode(code)}`;
    const reports = [
      { entry: value, modules: [moduleOf(value)], edges: [] },
      { entry: 'a', modules: [moduleOf('a')], edges: [edge('a', value, 'a')] },
      { entry: 'a', modules: [moduleOf('a')], edges: [edge(value, 'x', 'a')] },
      { entry: 'a', modules: [moduleOf('a')], edges: [edge('a', 'x', value)] },
    ];
    for (const report of reports) {
      const result = run(report);
      assert.equal(result.status, 1, `control ${code}: ${result.stderr}`);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'shape\n');
    }
  }
});
