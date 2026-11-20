import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const externals = fileURLToPath(new URL('./import-report-externals.mjs', import.meta.url));

test('externals report is identical after source root relocation and responds to changed imports', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'myrmidon-tests');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'externals-relocation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = join(dir, 'first');
  const second = join(dir, 'deep', 'space \u96ea', 'second');
  const marker = join(dir, 'executed');
  const sources = {
    'entry.mjs': `import './lib/child.mjs';\nimport 'pkg';\nimport('pkg/sub');\nimport './missing.mjs';\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`,
    'lib/child.mjs': "import 'pkg/sub';\nimport('pkg');\nimport('../lazy.mjs');\n",
    'lazy.mjs': "import 'pkg';\nimport('pkg/sub');\n",
  };
  for (const [name, content] of Object.entries(sources)) {
    const path = join(first, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  mkdirSync(join(dir, 'deep', 'space \u96ea'), { recursive: true });
  cpSync(first, second, { recursive: true });
  const checkSources = (root, expected) => {
    for (const [name, content] of Object.entries(expected)) assert.equal(readFileSync(join(root, name), 'utf8'), content);
  };
  checkSources(first, sources);
  checkSources(second, sources);
  const run = (program, args) => {
    const result = spawnSync(process.execPath, [program, ...args], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, TMPDIR: dir },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /\n$/);
    JSON.parse(result.stdout);
    return result.stdout;
  };
  const scanAndReport = (root, name) => {
    const scan = run(scanner, [join(root, 'entry.mjs')]);
    const reportPath = join(dir, `${name}.json`);
    writeFileSync(reportPath, scan);
    const output = run(externals, [reportPath]);
    assert.equal(readFileSync(reportPath, 'utf8'), scan);
    return { scan, output, reportPath };
  };
  const expected = {
    entry: 'entry.mjs',
    externals: [
      { specifier: 'pkg', eagerImporters: ['entry.mjs', 'lazy.mjs'], lazyImporters: ['lib/child.mjs'] },
      { specifier: 'pkg/sub', eagerImporters: ['lib/child.mjs'], lazyImporters: ['entry.mjs', 'lazy.mjs'] },
    ],
    unresolvedLocal: [{ specifier: './missing.mjs', eagerImporters: ['entry.mjs'], lazyImporters: [] }],
  };
  const a = scanAndReport(first, 'first-report');
  const b = scanAndReport(second, 'second-report');
  assert.equal(a.output, JSON.stringify(expected) + '\n');
  assert.equal(b.output, a.output);
  for (const output of [a.scan, b.scan, a.output, b.output]) {
    assert.equal(output.includes(first), false);
    assert.equal(output.includes(second), false);
  }
  checkSources(first, sources);
  checkSources(second, sources);
  assert.equal(existsSync(marker), false);

  const changedSources = { ...sources, 'lazy.mjs': "import 'pkg';\nimport('pkg/changed');\n" };
  writeFileSync(join(second, 'lazy.mjs'), changedSources['lazy.mjs']);
  const changed = scanAndReport(second, 'changed-report');
  const changedExpected = {
    entry: 'entry.mjs',
    externals: [
      { specifier: 'pkg', eagerImporters: ['entry.mjs', 'lazy.mjs'], lazyImporters: ['lib/child.mjs'] },
      { specifier: 'pkg/changed', eagerImporters: [], lazyImporters: ['lazy.mjs'] },
      { specifier: 'pkg/sub', eagerImporters: ['lib/child.mjs'], lazyImporters: ['entry.mjs'] },
    ],
    unresolvedLocal: [{ specifier: './missing.mjs', eagerImporters: ['entry.mjs'], lazyImporters: [] }],
  };
  assert.equal(changed.output, JSON.stringify(changedExpected) + '\n');
  assert.notEqual(changed.output, a.output);
  assert.equal(run(scanner, [join(first, 'entry.mjs')]), a.scan);
  assert.equal(run(externals, [a.reportPath]), a.output);
  assert.equal(readFileSync(a.reportPath, 'utf8'), a.scan);
  assert.equal(readFileSync(b.reportPath, 'utf8'), b.scan);
  assert.equal(readFileSync(changed.reportPath, 'utf8'), changed.scan);
  checkSources(first, sources);
  checkSources(second, changedSources);
  assert.equal(existsSync(marker), false);
});
