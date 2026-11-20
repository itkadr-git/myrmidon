import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-dominators.mjs');
const names = ['__proto__', 'constructor', 'toString', 'a/b', 'a\\b', '\u96ea', 'line\nbreak'];
const edge = (from, to) => ({ from, to, kind: 'eager', specifier: `import:${to}` });

function check(t, graph, target, dominators) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'dom-identities-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'report.json');
  const input = Buffer.from(JSON.stringify(graph));
  writeFileSync(path, input);
  const result = spawnSync(process.execPath, [cli, path, target], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify({ entry: graph.entry, target, dominators: [...dominators].sort() })}\n`);
  assert.deepEqual(readFileSync(path), input);
}

function graph(paths, edges) {
  return { entry: paths[0], modules: paths.map(path => ({ path, bytes: 1, eager: true })), edges };
}

function orders(input) {
  return [input, { ...input, modules: [...input.modules].reverse(), edges: [...input.edges].reverse() }];
}

test('chain preserves each exact identifier as a dominator at every target', t => {
  const paths = ['entry', ...names, 'end'];
  const input = graph(paths, paths.slice(1).map((name, i) => edge(paths[i], name)));
  for (const variant of orders(input)) {
    for (let i = 0; i < paths.length; i++) check(t, variant, paths[i], paths.slice(0, i + 1));
  }
});

test('diamond branches with collision-prone identifiers do not dominate the join', t => {
  for (let i = 0; i < names.length; i++) {
    const left = names[i], right = names[(i + 1) % names.length];
    const input = graph(['entry', left, right, 'join', 'end'], [
      edge('entry', left), edge('entry', right), edge(left, 'join'), edge(right, 'join'), edge('join', 'end'),
    ]);
    for (const variant of orders(input)) {
      check(t, variant, 'end', ['entry', 'join', 'end']);
      check(t, variant, left, ['entry', left]);
      check(t, variant, right, ['entry', right]);
    }
  }
});
