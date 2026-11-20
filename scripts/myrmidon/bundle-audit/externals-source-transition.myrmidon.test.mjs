import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-externals.mjs', import.meta.url));

function run(program, args, input) {
  const result = spawnSync(process.execPath, [program, ...args], { encoding: 'utf8', input, timeout: 10000 });
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('scanner and external inventory follow source transitions without executing modules', t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'externals-transition-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = join(dir, 'entry.mjs');
  const eager = join(dir, 'eager.mjs');
  const lazy = join(dir, 'lazy.mjs');
  const sentinel = join(dir, 'executed');
  const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('source executed');\n`;
  const before = {
    [entry]: `import './eager.mjs';\nimport('./lazy.mjs');\nimport 'example-pkg';\nimport('example-pkg');\n${guard}`,
    [eager]: `import 'example-pkg';\nimport('example-pkg');\n${guard}`,
    [lazy]: `import '@scope/pkg/sub';\nimport './missing.mjs';\n${guard}`,
  };
  const after = {
    ...before,
    [entry]: `import './eager.mjs';\nimport('./lazy.mjs');\nimport 'example-pkg';\n${guard}`,
    [eager]: `import('example-pkg');\n${guard}`,
  };
  const initialExpected = {
    entry: 'entry.mjs',
    externals: [
      { specifier: '@scope/pkg/sub', eagerImporters: ['lazy.mjs'], lazyImporters: [] },
      { specifier: 'example-pkg', eagerImporters: ['eager.mjs', 'entry.mjs'], lazyImporters: ['eager.mjs', 'entry.mjs'] },
    ],
    unresolvedLocal: [{ specifier: './missing.mjs', eagerImporters: ['lazy.mjs'], lazyImporters: [] }],
  };
  const changedExpected = {
    entry: 'entry.mjs',
    externals: [
      { specifier: '@scope/pkg/sub', eagerImporters: ['lazy.mjs'], lazyImporters: [] },
      { specifier: 'example-pkg', eagerImporters: ['entry.mjs'], lazyImporters: ['eager.mjs'] },
    ],
    unresolvedLocal: [{ specifier: './missing.mjs', eagerImporters: ['lazy.mjs'], lazyImporters: [] }],
  };
  const writeSources = sources => {
    for (const [path, source] of Object.entries(sources)) writeFileSync(path, source);
  };
  const checkSources = sources => {
    for (const [path, source] of Object.entries(sources)) assert.equal(readFileSync(path, 'utf8'), source);
    assert.equal(existsSync(sentinel), false);
  };
  const inspect = (sources, expected, name) => {
    const scan = run(scanner, [entry]);
    checkSources(sources);
    const reportPath = join(dir, `${name}.json`);
    writeFileSync(reportPath, scan);
    assert.deepEqual(JSON.parse(run(consumer, [reportPath])), expected);
    assert.equal(readFileSync(reportPath, 'utf8'), scan);
    assert.deepEqual(JSON.parse(run(consumer, ['-'], scan)), expected);
    checkSources(sources);
    return scan;
  };
  writeSources(before);
  inspect(before, initialExpected, 'initial');
  writeSources(after);
  inspect(after, changedExpected, 'changed');
  inspect(after, changedExpected, 'repeat');
});
