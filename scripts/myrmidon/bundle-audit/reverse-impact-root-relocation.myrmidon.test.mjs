import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const reverse = fileURLToPath(new URL('./import-report-reverse-impact.mjs', import.meta.url));

test('reverse impact is invariant under source root relocation and responds to changed imports', t => {
  const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'reverse-relocation-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const roots = [join(scratch, 'first'), join(scratch, 'deeper', 'tree \u00e9', 'second')];
  const sentinel = join(scratch, 'executed');
  const sources = {
    'entry.mjs': "import './middle.mjs'; import('./lazy.mjs');\n",
    'middle.mjs': "import './sub/end.mjs';\n",
    'lazy.mjs': "import './sub/end.mjs';\n",
    'sub/end.mjs': `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`,
  };
  for (const [name, content] of Object.entries(sources)) {
    const file = join(roots[0], name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  mkdirSync(dirname(roots[1]), { recursive: true });
  cpSync(roots[0], roots[1], { recursive: true });
  const snapshot = root => Object.fromEntries(Object.keys(sources).map(name => [name, readFileSync(join(root, name), 'utf8')]));
  assert.deepEqual(snapshot(roots[0]), sources);
  assert.deepEqual(snapshot(roots[1]), sources);
  const run = (script, args, input) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8', timeout: 10000, input, env: { ...process.env, TMPDIR: scratch },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /\n$/);
    assert.doesNotMatch(result.stdout, /\n\n$/);
    JSON.parse(result.stdout);
    return result.stdout;
  };
  const expected = { entry: 'entry.mjs', target: 'sub/end.mjs', importers: [
    { path: 'lazy.mjs', distance: 1 }, { path: 'middle.mjs', distance: 1 }, { path: 'entry.mjs', distance: 2 },
  ] };
  const reports = roots.map((root, i) => {
    const scan = run(scanner, [join(root, 'entry.mjs')]);
    const file = join(scratch, `report-${i}.json`);
    writeFileSync(file, scan);
    const output = run(reverse, [file, 'sub/end.mjs']);
    assert.equal(readFileSync(file, 'utf8'), scan);
    assert.equal(output, `${JSON.stringify(expected)}\n`);
    for (const path of roots) assert.equal(output.includes(path), false);
    return { file, scan, output };
  });
  assert.equal(reports[0].output, reports[1].output);
  assert.deepEqual(snapshot(roots[0]), sources);
  assert.deepEqual(snapshot(roots[1]), sources);
  assert.equal(existsSync(sentinel), false);

  const changed = { ...sources, 'middle.mjs': "export const changed = true;\n" };
  writeFileSync(join(roots[1], 'middle.mjs'), changed['middle.mjs']);
  const scan = run(scanner, [join(roots[1], 'entry.mjs')]);
  const controlFile = join(scratch, 'control.json');
  writeFileSync(controlFile, scan);
  const control = run(reverse, [controlFile, 'sub/end.mjs']);
  assert.equal(control, `${JSON.stringify({ entry: 'entry.mjs', target: 'sub/end.mjs', importers: [{ path: 'lazy.mjs', distance: 1 }] })}\n`);
  assert.notEqual(control, reports[0].output);
  for (const path of roots) assert.equal(control.includes(path), false);
  assert.equal(readFileSync(controlFile, 'utf8'), scan);
  for (const report of reports) assert.equal(readFileSync(report.file, 'utf8'), report.scan);
  assert.deepEqual(snapshot(roots[0]), sources);
  assert.deepEqual(snapshot(roots[1]), changed);
  assert.equal(existsSync(sentinel), false);
});
