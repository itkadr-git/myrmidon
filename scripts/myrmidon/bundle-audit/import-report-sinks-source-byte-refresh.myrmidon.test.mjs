import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-sinks.mjs', import.meta.url));
const marker = "throw new Error('fixture must not execute');\n";
const sources = (suffix) => ({
  'entry.mjs': `import './left.mjs';\nimport './right.mjs';\nimport './loop.mjs';\nimport('./lazy.mjs');\n${marker}`,
  'left.mjs': `import './leaf.mjs';\n${marker}// ${suffix}\n`,
  'right.mjs': `import './leaf.mjs';\n${marker}`,
  'leaf.mjs': `${marker}const text = ${JSON.stringify(suffix)};\n`,
  'loop.mjs': `import './loop.mjs';\n${marker}`,
  'lazy.mjs': `${marker}// ${suffix}\n`,
});

function run(script, args, input) {
  const result = spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('fresh source bytes flow through scanner and sinks across A B C A', () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(scratch, 'sinks-refresh-'));
  try {
    let topology, firstOutput, firstReport;
    const states = ['a', 'ascii expanded', '\u96ea\u3060\u308b\u307e\nsecond line', 'a'];
    for (const [index, suffix] of states.entries()) {
      const files = sources(suffix);
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
      const raw = run(scanner, [join(dir, 'entry.mjs')]);
      const report = JSON.parse(raw);
      const currentTopology = { entry: report.entry, edges: report.edges, paths: report.modules.map(m => m.path) };
      if (index === 0) { topology = currentTopology; firstReport = raw; }
      assert.deepEqual(currentTopology, topology);
      assert.deepEqual(report.modules.map(({ path, bytes }) => [path, bytes]),
        Object.keys(files).sort().map(path => [path, Buffer.byteLength(files[path])]));
      const leafBytes = Buffer.byteLength(files['leaf.mjs']);
      const expected = JSON.stringify({ entry: 'entry.mjs', sinks: [{ path: 'leaf.mjs', bytes: leafBytes }], sinkBytes: leafBytes }) + '\n';
      const output = run(consumer, [], raw);
      assert.equal(output, expected);
      if (index === 1) {
        const staleOutput = run(consumer, [], firstReport);
        assert.notEqual(staleOutput, expected);
      }
      if (index === 0) firstOutput = output;
      if (index === 1) assert.notEqual(raw, firstReport);
      if (index === 3) assert.equal(output, firstOutput);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
