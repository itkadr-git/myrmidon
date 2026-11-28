import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = name => fileURLToPath(new URL(`./import-report-${name}.mjs`, import.meta.url));
const fixture = {
  entry: 'entry',
  modules: [
    { path: 'entry', bytes: 2, eager: true },
    { path: 'a', bytes: 2, eager: true },
    { path: 'b', bytes: 2, eager: true },
    { path: 'target', bytes: 2, eager: true },
  ],
  edges: [
    { from: 'entry', to: 'a', kind: 'eager', specifier: './a' },
    { from: 'entry', to: 'b', kind: 'eager', specifier: './b' },
    { from: 'a', to: 'target', kind: 'eager', specifier: './target' },
    { from: 'b', to: 'target', kind: 'eager', specifier: './target' },
    { from: 'target', to: 'target', kind: 'eager', specifier: './target' },
    { from: 'entry', to: 'target', kind: 'lazy', specifier: './\u{1f680}' },
  ],
};
const compact = JSON.stringify(fixture);
const representations = [
  compact,
  ` \t\r\n${JSON.stringify(fixture, null, 2).replaceAll('\n', '\r\n')}\r\n `,
  compact.replace('"entry":', '"\\u0065ntry":').replaceAll('/', '\\/').replace('\u{1f680}', '\\ud83d\\ude80'),
  compact.replace('"bytes":2,', '"bytes":2.0,').replace('"bytes":2,', '"bytes":2e0,'),
  compact,
];
const expectedTarget = '{"entry":"entry","target":"target","dominators":["entry","target"]}\n';
const expectedEntry = '{"entry":"entry","target":"entry","dominators":["entry"]}\n';
const expectedCut = '{"entry":"entry","removed":"a","lostPaths":["a"],"lostBytes":2}\n';
const expectedSubgraph = '{"root":"entry","mode":"eager","modules":[{"path":"a","bytes":2,"eager":true},{"path":"b","bytes":2,"eager":true},{"path":"entry","bytes":2,"eager":true},{"path":"target","bytes":2,"eager":true}],"edges":[{"from":"a","to":"target","kind":"eager","specifier":"./target"},{"from":"b","to":"target","kind":"eager","specifier":"./target"},{"from":"entry","to":"a","kind":"eager","specifier":"./a"},{"from":"entry","to":"b","kind":"eager","specifier":"./b"},{"from":"target","to":"target","kind":"eager","specifier":"./target"}],"unknown":[]}\n';

function run(name, args, input) {
  const result = spawnSync(process.execPath, [cli(name), ...args], { input, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}
function success(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, expected);
}

test('equivalent JSON representations preserve CLI results', t => {
  const root = mkdtempSync(join(process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'dom-json-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'report.json');
  for (const encoded of representations) {
    assert.deepEqual(JSON.parse(encoded), fixture);
    writeFileSync(path, encoded);
    const before = readFileSync(path);
    for (const source of [path, '-']) {
      success(run('dominators', [source, 'target'], encoded), expectedTarget);
      success(run('dominators', [source, 'entry'], encoded), expectedEntry);
      success(run('subgraph', [source, 'entry', 'eager'], encoded), expectedSubgraph);
    }
    success(run('cut-impact', ['a'], encoded), expectedCut);
    assert.deepEqual(readFileSync(path), before);
  }
  const changed = structuredClone(fixture);
  changed.edges = changed.edges.filter(edge => !(edge.from === 'b' && edge.to === 'target'));
  const input = JSON.stringify(changed);
  success(run('dominators', ['-', 'target'], input), '{"entry":"entry","target":"target","dominators":["a","entry","target"]}\n');
  success(run('cut-impact', ['a'], input), '{"entry":"entry","removed":"a","lostPaths":["a","target"],"lostBytes":4}\n');
});

test('unescaped control characters fail closed without reflecting input', () => {
  const invalid = '{"marker":"SECRET_MARKER\u0001"}';
  for (const [name, args] of [['dominators', ['-', 'target']], ['subgraph', ['-', 'entry', 'eager']], ['cut-impact', ['a']]]) {
    const result = run(name, args, invalid);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /SECRET_MARKER/);
  }
});
