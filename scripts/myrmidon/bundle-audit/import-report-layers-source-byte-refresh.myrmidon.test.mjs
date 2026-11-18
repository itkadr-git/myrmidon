import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-layers.mjs', import.meta.url));
const imports = {
  'entry.mjs': "import './a.mjs';\nimport './b.mjs';\nimport('./deep.mjs');\nimport('./lazy.mjs');\n",
  'a.mjs': "import './deep.mjs';\n",
  'b.mjs': "import './deep.mjs';\n",
  'deep.mjs': "import './leaf.mjs';\n",
  'leaf.mjs': '',
  'lazy.mjs': '',
};
const marker = "throw new Error('fixture must not execute');\n";
const source = (changes) => Object.fromEntries(Object.entries(imports).map(([path, prefix]) => [path, `${prefix}${marker}${changes[path] ?? ''}`]));
const states = [
  source({}),
  source({ 'entry.mjs': '// ASCII refresh\n', 'a.mjs': "const text = 'changed';\n", 'deep.mjs': '// deeper\n', 'lazy.mjs': '// lazy\n' }),
  source({ 'entry.mjs': '// \u00e9\u96ea\n\n', 'b.mjs': "const text = '\u732b';\n", 'leaf.mjs': '// \u{1f680}\n\n', 'lazy.mjs': '// \u96ea\n' }),
];
const run = (program, args, input) => {
  const result = spawnSync(process.execPath, [program, ...args], { input, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
};
const expected = (sources) => {
  const size = path => Buffer.byteLength(sources[path], 'utf8');
  return {
    entry: 'entry.mjs',
    layers: [
      { depth: 0, paths: ['entry.mjs'], bytes: size('entry.mjs') },
      { depth: 1, paths: ['a.mjs', 'b.mjs'], bytes: size('a.mjs') + size('b.mjs') },
      { depth: 2, paths: ['deep.mjs'], bytes: size('deep.mjs') },
      { depth: 3, paths: ['leaf.mjs'], bytes: size('leaf.mjs') },
    ],
    unreachable: ['lazy.mjs'],
  };
};

test('refreshes layer bytes for unchanged diamond imports across A B C A', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'layers-refresh-'));
  try {
    let topology, firstOutput, firstReport;
    const lazyOnly = source({ 'lazy.mjs': '// ASCII lazy-only growth\n' });
    for (const sources of [states[0], states[1], lazyOnly, states[2], states[0]]) {
      for (const [path, content] of Object.entries(sources)) writeFileSync(join(dir, path), content);
      const reportText = run(scanner, [join(dir, 'entry.mjs')]);
      const report = JSON.parse(reportText);
      const currentTopology = { entry: report.entry, edges: report.edges, modules: report.modules.map(({ path, eager }) => ({ path, eager })) };
      if (topology) assert.deepEqual(currentTopology, topology);
      else topology = currentTopology;
      assert.deepEqual(report.modules.map(({ path, bytes }) => [path, bytes]), Object.keys(sources).sort().map(path => [path, Buffer.byteLength(sources[path], 'utf8')]));
      const output = run(consumer, [], reportText);
      assert.equal(output, `${JSON.stringify(expected(sources))}\n`);
      if (firstOutput === undefined) {
        firstOutput = output;
        firstReport = reportText;
      } else if (sources === states[1]) {
        assert.equal(run(consumer, [], firstReport), firstOutput);
        assert.notEqual(output, firstOutput);
      } else if (sources === lazyOnly || sources === states[0]) {
        assert.equal(output, firstOutput);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
