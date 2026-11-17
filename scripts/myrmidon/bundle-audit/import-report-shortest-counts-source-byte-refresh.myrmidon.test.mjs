import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-shortest-counts.mjs', import.meta.url));
const imports = {
  'entry.mjs': "import './a';\nimport './a.mjs';\nimport './b.mjs';\nimport('./end.mjs');\nimport('./lazy.mjs');\n",
  'a.mjs': "import './c.mjs';\nimport './d.mjs';\n",
  'b.mjs': "import './c.mjs';\nimport './d.mjs';\n",
  'c.mjs': "import './end.mjs';\n",
  'd.mjs': "import './end.mjs';\n",
  'end.mjs': "import './entry.mjs';\n",
  'lazy.mjs': '',
};
const expected = {
  entry: 'entry.mjs',
  modules: [
    { path: 'a.mjs', depth: 1, shortestPaths: '1' },
    { path: 'b.mjs', depth: 1, shortestPaths: '1' },
    { path: 'c.mjs', depth: 2, shortestPaths: '2' },
    { path: 'd.mjs', depth: 2, shortestPaths: '2' },
    { path: 'end.mjs', depth: 3, shortestPaths: '4' },
    { path: 'entry.mjs', depth: 0, shortestPaths: '1' },
  ],
  unreachable: ['lazy.mjs'],
};
const run = (script, args, input, cwd) => {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
};

test('fresh source bytes preserve shortest counts through A B C A', () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.myrmidon-scratch');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'shortest-refresh-'));
  try {
    let originalTopology, originalOutput;
    for (const [index, value] of ['initial', 'longer ascii text', '\u00e9\u6f22\nsecond line', 'initial'].entries()) {
      const sources = Object.fromEntries(Object.entries(imports).map(([name, lines]) => [name,
        `${lines}const payload = ${JSON.stringify(value)};\n// ${value.replaceAll('\n', '\n// ')}\nthrow new Error('must not execute fixture');\n`,
      ]));
      for (const [name, source] of Object.entries(sources)) writeFileSync(join(dir, name), source);
      const scanned = run(scanner, [join(dir, 'entry.mjs')], undefined, dir);
      const report = JSON.parse(scanned);
      const paths = Object.keys(sources).sort();
      assert.deepEqual(report.modules.map(module => module.path), paths);
      assert.deepEqual(report.modules.map(module => module.bytes), paths.map(path => Buffer.byteLength(sources[path], 'utf8')));
      const topology = { entry: report.entry, edges: report.edges, modules: report.modules.map(({ path, eager }) => ({ path, eager })) };
      if (index === 0) originalTopology = topology;
      else assert.deepEqual(topology, originalTopology);
      const output = run(consumer, [], scanned, dir);
      assert.equal(output, `${JSON.stringify(expected)}\n`);
      if (index === 0) originalOutput = output;
      if (index === 3) assert.equal(output, originalOutput);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
