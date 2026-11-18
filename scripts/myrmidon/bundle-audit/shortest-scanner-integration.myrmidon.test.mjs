import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = process.env.MYRMIDON_SHORTEST_TEST_CLI
  ? resolve(process.env.MYRMIDON_SHORTEST_TEST_CLI)
  : fileURLToPath(new URL('./import-report-shortest-counts.mjs', import.meta.url));

function run(cli, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  return result.stdout;
}

test('scanner output feeds shortest counts without executing source', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'shortest-integration-'));
  try {
    const sentinel = join(dir, 'executed');
    const trap = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('fixture executed');\n`;
    const entry = "import './left.mjs';\nimport './right.mjs';\nimport('external-package');\nimport('./end.mjs');\nimport('./lazy.mjs');\n" + trap;
    const files = {
      'entry.mjs': entry,
      'left.mjs': "import './end.mjs';\n" + trap,
      'right.mjs': "import './end.mjs';\n" + trap,
      'end.mjs': trap,
      'lazy.mjs': trap,
    };
    for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);

    const expectedBefore = {
      entry: 'entry.mjs',
      modules: [
        { path: 'end.mjs', depth: 2, shortestPaths: '2' },
        { path: 'entry.mjs', depth: 0, shortestPaths: '1' },
        { path: 'left.mjs', depth: 1, shortestPaths: '1' },
        { path: 'right.mjs', depth: 1, shortestPaths: '1' },
      ],
      unreachable: ['lazy.mjs'],
    };
    const expectedAfter = {
      entry: 'entry.mjs',
      modules: [
        { path: 'end.mjs', depth: 1, shortestPaths: '1' },
        { path: 'entry.mjs', depth: 0, shortestPaths: '1' },
        { path: 'left.mjs', depth: 1, shortestPaths: '1' },
        { path: 'right.mjs', depth: 1, shortestPaths: '1' },
      ],
      unreachable: ['lazy.mjs'],
    };
    function check(expected, shortcut) {
      const stdout = run(scanner, [join(dir, 'entry.mjs')]);
      assert.equal(existsSync(sentinel), false);
      const report = JSON.parse(stdout);
      const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
      assert.deepEqual(report.edges, [
        ...(shortcut ? [edge('entry.mjs', './end.mjs', 'eager', 'end.mjs')] : []),
        edge('entry.mjs', './end.mjs', 'lazy', 'end.mjs'),
        edge('entry.mjs', './lazy.mjs', 'lazy', 'lazy.mjs'),
        edge('entry.mjs', './left.mjs', 'eager', 'left.mjs'),
        edge('entry.mjs', './right.mjs', 'eager', 'right.mjs'),
        edge('entry.mjs', 'external-package', 'lazy', null),
        edge('left.mjs', './end.mjs', 'eager', 'end.mjs'),
        edge('right.mjs', './end.mjs', 'eager', 'end.mjs'),
      ]);
      assert.deepEqual(report.unknown, [edge('entry.mjs', 'external-package', 'lazy', null)]);
      assert.deepEqual(JSON.parse(run(consumer, [], stdout)), expected);
      assert.equal(existsSync(sentinel), false);
    }
    check(expectedBefore, false);
    writeFileSync(join(dir, 'entry.mjs'), "import './end.mjs';\n" + entry);
    check(expectedAfter, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
