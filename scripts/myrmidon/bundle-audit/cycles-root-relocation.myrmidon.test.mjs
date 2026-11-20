import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(process.env.HOME, '.cache');

function run(script, args, tmp) {
  const result = spawnSync(process.execPath, [join(dir, script), ...args], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, TMPDIR: tmp },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /}\n$/);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  return result.stdout;
}

test('cycles report is identical after relocating sources and responds to a changed edge', t => {
  mkdirSync(scratch, { recursive: true });
  const tmp = mkdtempSync(join(scratch, 'cycles-relocation-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const first = join(tmp, 'first');
  const second = join(tmp, 'nested', 'source \u96ea tree');
  mkdirSync(first, { recursive: true });
  const sentinel = join(tmp, 'executed');
  const sources = {
    'entry.mjs': `import './eager-a.mjs';\nimport('./lazy-a.mjs');\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\n`,
    'eager-a.mjs': "import './eager-b.mjs';\n",
    'eager-b.mjs': "import './eager-a.mjs';\n",
    'lazy-a.mjs': "import './lazy-b.mjs';\n",
    'lazy-b.mjs': "import('./lazy-a.mjs');\n",
  };
  for (const [name, text] of Object.entries(sources)) writeFileSync(join(first, name), text);
  mkdirSync(dirname(second), { recursive: true });
  cpSync(first, second, { recursive: true });
  const checkSources = (root, expected) => {
    for (const [name, text] of Object.entries(expected)) assert.equal(readFileSync(join(root, name), 'utf8'), text);
  };
  checkSources(first, sources); checkSources(second, sources);
  const scan = root => run('import-budget.mjs', [join(root, 'entry.mjs')], tmp);
  const report1 = scan(first), report2 = scan(second);
  assert.equal(report1, report2);
  const files = [join(tmp, 'report1.json'), join(tmp, 'report2.json')];
  writeFileSync(files[0], report1); writeFileSync(files[1], report2);
  const output1 = run('import-report-cycles.mjs', [files[0]], tmp);
  const output2 = run('import-report-cycles.mjs', [files[1]], tmp);
  const expected = { entry: 'entry.mjs', eagerCycles: [['eager-a.mjs', 'eager-b.mjs']], allCycles: [['eager-a.mjs', 'eager-b.mjs'], ['lazy-a.mjs', 'lazy-b.mjs']] };
  assert.equal(output1, JSON.stringify(expected) + '\n');
  assert.equal(output2, JSON.stringify(expected) + '\n');
  assert.equal(output1, output2);
  for (const output of [report1, report2, output1, output2]) {
    assert.equal(output.includes(first), false); assert.equal(output.includes(second), false);
  }
  checkSources(first, sources); checkSources(second, sources);
  assert.equal(readFileSync(files[0], 'utf8'), report1); assert.equal(readFileSync(files[1], 'utf8'), report2);
  assert.equal(existsSync(sentinel), false);

  const changed = { ...sources, 'lazy-b.mjs': '// no return edge\n' };
  writeFileSync(join(second, 'lazy-b.mjs'), changed['lazy-b.mjs']);
  const control = scan(second);
  const controlFile = join(tmp, 'control.json'); writeFileSync(controlFile, control);
  const controlOutput = run('import-report-cycles.mjs', [controlFile], tmp);
  const controlExpected = { entry: 'entry.mjs', eagerCycles: [['eager-a.mjs', 'eager-b.mjs']], allCycles: [['eager-a.mjs', 'eager-b.mjs']] };
  assert.equal(controlOutput, JSON.stringify(controlExpected) + '\n');
  assert.notEqual(controlOutput, output1);
  assert.equal(scan(first), report1);
  checkSources(first, sources); checkSources(second, changed);
  assert.equal(readFileSync(files[0], 'utf8'), report1); assert.equal(readFileSync(files[1], 'utf8'), report2);
  assert.equal(readFileSync(controlFile, 'utf8'), control);
  assert.equal(existsSync(sentinel), false);
});
