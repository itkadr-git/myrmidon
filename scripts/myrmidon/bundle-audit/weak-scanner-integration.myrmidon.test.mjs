import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = process.env.MYRMIDON_WEAK_CONSUMER || fileURLToPath(new URL('./import-report-weak-components.mjs', import.meta.url));

function run(cli, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.endsWith('\n'));
  return { raw: result.stdout, value: JSON.parse(result.stdout) };
}

test('real scanner preserves weak partitions and bytes across lazy-to-eager change without executing sources', t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'weak-integration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sentinel = join(dir, 'executed');
  const sources = {
    'entry.mjs': `import './middle.mjs';\nimport('external-package');\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('fixture executed');\n`,
    'middle.mjs': "import './tail.mjs';\nimport('./island.mjs');\n",
    'tail.mjs': 'export const tail = 1;\n',
    'island.mjs': "import './island-leaf.mjs';\n",
    'island-leaf.mjs': 'export const leaf = 2;\n',
  };
  for (const [name, source] of Object.entries(sources)) writeFileSync(join(dir, name), source);
  const bytes = names => names.reduce((sum, name) => sum + Buffer.byteLength(sources[name]), 0);
  const entryPaths = ['entry.mjs', 'middle.mjs', 'tail.mjs'];
  const islandPaths = ['island-leaf.mjs', 'island.mjs'];
  const allPaths = ['entry.mjs', 'island-leaf.mjs', 'island.mjs', 'middle.mjs', 'tail.mjs'];
  const expected = paths => ({ id: paths[0], paths, bytes: bytes(paths) });
  const check = (mode, report, components) => {
    const actual = run(consumer, [mode], report.raw);
    assert.deepEqual(actual.value, { entry: 'entry.mjs', components });
    assert.equal(existsSync(sentinel), false);
  };
  const scan = () => {
    const report = run(scanner, [join(dir, 'entry.mjs')]);
    assert.equal(existsSync(sentinel), false);
    assert.deepEqual(report.value.modules.map(({ path, bytes: size }) => ({ path, bytes: size })),
      allPaths.map(path => ({ path, bytes: Buffer.byteLength(sources[path]) })));
    assert.deepEqual(report.value.edges.filter(edge => edge.specifier === 'external-package'),
      [{ from: 'entry.mjs', specifier: 'external-package', kind: 'lazy', to: null }]);
    return report;
  };
  const before = scan();
  check('eager', before, [expected(entryPaths), expected(islandPaths)]);
  check('all', before, [expected(allPaths)]);

  sources['middle.mjs'] = "import './tail.mjs';\nimport './island.mjs';\n";
  writeFileSync(join(dir, 'middle.mjs'), sources['middle.mjs']);
  const after = scan();
  check('eager', after, [expected(allPaths)]);
  check('all', after, [expected(allPaths)]);
});
