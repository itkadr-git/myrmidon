import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const layers = fileURLToPath(new URL('./import-report-layers.mjs', import.meta.url));
const sources = {
  'entry.mjs': 'import "./a.mjs";\nimport("./b.mjs");\nimport("./lazy.mjs");\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.TMPDIR + "/SENTINEL_EXECUTED", "executed");\n',
  'a.mjs': 'import "./b.mjs";\n',
  'b.mjs': 'export default 1;\n',
  'lazy.mjs': 'export default 2;\n',
};
const changedA = 'import "./b.mjs";\nexport const changed = true;\n';
const expected = {
  entry: 'entry.mjs',
  layers: [
    { depth: 0, paths: ['entry.mjs'], bytes: 170 },
    { depth: 1, paths: ['a.mjs'], bytes: 18 },
    { depth: 2, paths: ['b.mjs'], bytes: 18 },
  ],
  unreachable: ['lazy.mjs'],
};
const changedExpected = {
  entry: 'entry.mjs',
  layers: [
    { depth: 0, paths: ['entry.mjs'], bytes: 170 },
    { depth: 1, paths: ['a.mjs'], bytes: 47 },
    { depth: 2, paths: ['b.mjs'], bytes: 18 },
  ],
  unreachable: ['lazy.mjs'],
};

function run(script, args, scratch, input) {
  const result = spawnSync(process.execPath, [script, ...args], {
    input, encoding: 'utf8', timeout: 5000, env: { ...process.env, TMPDIR: scratch },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /\n$/);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  return result.stdout;
}

function checkSources(root, contents) {
  for (const [name, content] of Object.entries(contents)) {
    assert.deepEqual(readFileSync(join(root, name)), Buffer.from(content));
  }
}

test('layers output survives source root relocation and detects a changed source', t => {
  const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'layers-relocation-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const first = join(scratch, 'first');
  const second = join(scratch, 'deeper', 'source tree \u03bb');
  mkdirSync(first, { recursive: true });
  for (const [name, content] of Object.entries(sources)) writeFileSync(join(first, name), content);
  mkdirSync(dirname(second), { recursive: true });
  cpSync(first, second, { recursive: true });
  checkSources(first, sources);
  checkSources(second, sources);

  const scan = root => run(scanner, [join(root, 'entry.mjs')], scratch);
  const report = input => run(layers, [], scratch, input);
  const scans = [scan(first), scan(second)];
  const saved = scans.map((text, i) => {
    const path = join(scratch, `report-${i}.json`);
    writeFileSync(path, text);
    return path;
  });
  const outputs = scans.map(report);
  assert.equal(outputs[0], `${JSON.stringify(expected)}\n`);
  assert.equal(outputs[1], outputs[0]);
  for (const output of [...scans, ...outputs]) {
    assert.ok(!output.includes(first));
    assert.ok(!output.includes(second));
  }
  checkSources(first, sources);
  checkSources(second, sources);
  for (let i = 0; i < saved.length; i++) assert.equal(readFileSync(saved[i], 'utf8'), scans[i]);

  writeFileSync(join(second, 'a.mjs'), changedA);
  const controlScan = scan(second);
  const controlOutput = report(controlScan);
  assert.equal(controlOutput, `${JSON.stringify(changedExpected)}\n`);
  assert.notEqual(controlOutput, outputs[0]);
  assert.equal(report(scan(first)), outputs[0]);
  for (const output of [controlScan, controlOutput]) {
    assert.ok(!output.includes(first));
    assert.ok(!output.includes(second));
  }
  checkSources(first, sources);
  checkSources(second, { ...sources, 'a.mjs': changedA });
  for (let i = 0; i < saved.length; i++) assert.equal(readFileSync(saved[i], 'utf8'), scans[i]);
  assert.equal(existsSync(join(scratch, 'SENTINEL_EXECUTED')), false);
});
