import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-layers.mjs', import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
const name = i => `n${String(i).padStart(5, '0')}`;
const moduleOf = (path, eager = true) => ({ path, bytes: 1, eager });
const edge = (from, to, specifier, kind = 'eager') => ({ from, to, specifier, kind });

function check(report, expected) {
  for (const input of [report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
    const result = spawnSync(process.execPath, [cli], {
      input: JSON.stringify(input), encoding: 'utf8', timeout: 30000,
      maxBuffer: 32 * 1024 * 1024, env: { ...process.env, TMPDIR: scratch },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
}

test('16,000 eager modules retain every depth under reversed input', () => {
  const count = 16000;
  const modules = Array.from({ length: count }, (_, i) => moduleOf(name(i)));
  const edges = Array.from({ length: count - 1 }, (_, i) => edge(name(i), name(i + 1), `link${i}`));
  const layers = Array.from({ length: count }, (_, i) => ({ depth: i, paths: [name(i)], bytes: 1 }));
  check({ entry: name(0), modules, edges }, { entry: name(0), layers, unreachable: [] });
});

test('12,000 eager leaves deduplicate aliases and ignore lazy links under reversed input', () => {
  const count = 12000;
  const leaves = Array.from({ length: count }, (_, i) => name(i));
  const unreachable = ['isolated-a', 'isolated-b', 'isolated-c'];
  const modules = [moduleOf('entry'), ...leaves.map(path => moduleOf(path)), ...unreachable.map(path => moduleOf(path, false))];
  const edges = leaves.flatMap(path => [edge('entry', path, `first-${path}`), edge('entry', path, `second-${path}`)]);
  edges.push(edge('entry', 'isolated-a', 'lazy-shortcut', 'lazy'));
  check({ entry: 'entry', modules, edges }, {
    entry: 'entry', layers: [{ depth: 0, paths: ['entry'], bytes: 1 }, { depth: 1, paths: leaves, bytes: count }], unreachable,
  });
});
