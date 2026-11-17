import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.myrmidon-test-scratch');
const imports = {
  'entry.mjs': "import './cut.mjs';\nimport './shared.mjs';\nimport('./lazy.mjs');\n",
  'cut.mjs': "import './child.mjs';\nimport './shared.mjs';\n",
  'child.mjs': '',
  'shared.mjs': '',
  'lazy.mjs': '',
};
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const topology = {
  entry: 'entry.mjs',
  paths: ['child.mjs', 'cut.mjs', 'entry.mjs', 'lazy.mjs', 'shared.mjs'],
  edges: [
    edge('cut.mjs', './child.mjs', 'eager', 'child.mjs'),
    edge('cut.mjs', './shared.mjs', 'eager', 'shared.mjs'),
    edge('entry.mjs', './cut.mjs', 'eager', 'cut.mjs'),
    edge('entry.mjs', './lazy.mjs', 'lazy', 'lazy.mjs'),
    edge('entry.mjs', './shared.mjs', 'eager', 'shared.mjs'),
  ],
};

function run(args, options = {}) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10_000, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

for (const changed of ['cut.mjs', 'child.mjs', 'shared.mjs', 'lazy.mjs']) {
  test(`fresh bytes after source-only changes to ${changed}`, () => {
    mkdirSync(scratch, { recursive: true });
    const dir = mkdtempSync(join(scratch, 'cut-refresh-'));
    try {
      let initialOutput;
      for (const [index, suffix] of ['', 'ascii padding', '\u00e9\u6f22\n// second line', ''].entries()) {
        const sources = Object.fromEntries(Object.entries(imports).map(([name, statements]) => [name,
          `${statements}throw new Error('fixture must not execute');\n// ${name === changed ? suffix : ''}\n`,
        ]));
        for (const [name, source] of Object.entries(sources)) {
          writeFileSync(join(dir, name), source);
          assert.equal(run(['--check', join(dir, name)]), '');
        }
        const scan = run([scanner, join(dir, 'entry.mjs')]);
        const report = JSON.parse(scan);
        assert.equal(report.entry, topology.entry);
        assert.deepEqual(report.edges, topology.edges);
        assert.deepEqual(report.modules.map(module => module.path), topology.paths);
        assert.deepEqual(report.modules.map(module => [module.path, module.bytes, module.eager]),
          topology.paths.map(path => [path, Buffer.byteLength(sources[path], 'utf8'), path !== 'lazy.mjs']));
        const output = run([consumer, 'cut.mjs'], { input: scan });
        const expected = { entry: 'entry.mjs', removed: 'cut.mjs', lostPaths: ['child.mjs', 'cut.mjs'],
          lostBytes: Buffer.byteLength(sources['child.mjs'], 'utf8') + Buffer.byteLength(sources['cut.mjs'], 'utf8') };
        assert.equal(output, `${JSON.stringify(expected)}\n`);
        if (index === 0) initialOutput = output;
        if (index === 3) assert.equal(output, initialOutput);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
