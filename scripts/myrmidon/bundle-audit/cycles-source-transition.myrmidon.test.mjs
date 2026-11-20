import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const scanner = join(here, 'import-budget.mjs');
const consumer = join(here, 'import-report-cycles.mjs');
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || process.env.HOME;

const expected = [
  { entry: 'entry.mjs', eagerCycles: [], allCycles: [] },
  { entry: 'entry.mjs', eagerCycles: [], allCycles: [['entry.mjs', 'leaf.mjs', 'left.mjs', 'right.mjs']] },
  { entry: 'entry.mjs', eagerCycles: [['entry.mjs', 'leaf.mjs', 'left.mjs', 'right.mjs']], allCycles: [['entry.mjs', 'leaf.mjs', 'left.mjs', 'right.mjs']] },
  { entry: 'entry.mjs', eagerCycles: [['entry.mjs', 'leaf.mjs', 'left.mjs', 'right.mjs'], ['self.mjs']], allCycles: [['entry.mjs', 'leaf.mjs', 'left.mjs', 'right.mjs'], ['self.mjs']] },
];

test('rescans source transitions without executing modules or reusing a stale report', t => {
  const dir = mkdtempSync(join(scratch, 'cycles-transition-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sentinel = join(dir, 'executed');
  const poison = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('source executed');\n`;
  const sources = {
    'entry.mjs': "import './left.mjs';\nimport './right.mjs';\nimport './self.mjs';\n" + poison,
    'left.mjs': "import './leaf.mjs';\n" + poison,
    'right.mjs': "import './leaf.mjs';\n" + poison,
    'leaf.mjs': poison,
    'self.mjs': poison,
  };
  const write = name => writeFileSync(join(dir, name), sources[name]);
  Object.keys(sources).forEach(write);
  const run = (script, args, input) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: dir, input, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout;
  };
  const scanAndCheck = (index, protocol) => {
    const scan = run(scanner, [join(dir, 'entry.mjs')]);
    const report = join(dir, 'report.json');
    writeFileSync(report, scan);
    const output = protocol === 'stdin' ? run(consumer, ['-'], scan) : run(consumer, [report]);
    assert.deepEqual(JSON.parse(output), expected[index]);
    assert.equal(output, JSON.stringify(expected[index]) + '\n');
    assert.equal(readFileSync(report, 'utf8'), scan);
    for (const [name, source] of Object.entries(sources)) assert.equal(readFileSync(join(dir, name), 'utf8'), source);
    assert.equal(existsSync(sentinel), false);
    return scan;
  };
  scanAndCheck(0, 'file');
  sources['leaf.mjs'] = "import('./entry.mjs');\n" + poison; write('leaf.mjs');
  scanAndCheck(1, 'stdin');
  scanAndCheck(1, 'file');
  sources['leaf.mjs'] = "import './entry.mjs';\n" + poison; write('leaf.mjs');
  scanAndCheck(2, 'file');
  sources['self.mjs'] = "import './self.mjs';\n" + poison; write('self.mjs');
  scanAndCheck(3, 'stdin');
});
