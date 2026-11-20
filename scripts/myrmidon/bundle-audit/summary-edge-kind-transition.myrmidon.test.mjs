import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const summary = fileURLToPath(new URL('./import-report-summary.mjs', import.meta.url));

function run(cli, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.length > 0 && result.stdout.endsWith('\n'));
  return result.stdout;
}

test('summary tracks static to dynamic to static edges without executing sources', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'summary-transition-'));
  try {
    const sentinel = join(dir, 'executed');
    const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('fixture executed');\n`;
    const staticEntry = "import './bridge.mjs';\n// \u00e9\u96ea\n" + guard;
    const dynamicEntry = "import('./bridge.mjs');\n// \u00e9\u96ea\n" + guard;
    const bridge = "import './leaf.mjs';\n// \u03bb " + 'b'.repeat(80) + '\n' + guard;
    const leaf = '// \u732b ' + 'l'.repeat(200) + '\n' + guard;
    const entryPath = join(dir, 'entry.mjs');
    const bridgePath = join(dir, 'bridge.mjs');
    const leafPath = join(dir, 'leaf.mjs');
    writeFileSync(bridgePath, bridge);
    writeFileSync(leafPath, leaf);

    let consumer = summary;
    if (process.env.MYRMIDON_SUMMARY_TRANSITION_TEST_FREEZE === '1') {
      consumer = join(dir, 'frozen-consumer.mjs');
      const cache = join(dir, 'frozen-output');
      writeFileSync(consumer, `import { existsSync, readFileSync, writeFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nconst input = readFileSync(0);\nconst cache = ${JSON.stringify(cache)};\nif (!existsSync(cache)) {\n  const r = spawnSync(process.execPath, [${JSON.stringify(summary)}], { input });\n  if (r.error || r.signal || r.status !== 0 || r.stderr.length) process.exit(1);\n  writeFileSync(cache, r.stdout);\n}\nprocess.stdout.write(readFileSync(cache));\n`);
    }

    function phase(source, eager) {
      writeFileSync(entryPath, source);
      const report = run(scanner, [entryPath]);
      assert.equal(existsSync(sentinel), false, 'scanner executed a fixture');
      const markdown = run(consumer, [], report);
      assert.equal(existsSync(sentinel), false, 'summary executed a fixture');
      const entryBytes = Buffer.byteLength(source);
      const bridgeBytes = Buffer.byteLength(bridge);
      const leafBytes = Buffer.byteLength(leaf);
      const metrics = [
        '| Metric | Value |', '| --- | ---: |', '| modules | 3 |',
        `| eagerModules | ${eager ? 3 : 1} |`,
        `| totalBytes | ${entryBytes + bridgeBytes + leafBytes} |`,
        `| eagerBytes | ${entryBytes + (eager ? bridgeBytes + leafBytes : 0)} |`,
      ].join('\n');
      assert.ok(markdown.includes(metrics), 'exact metric rows');
      const table = ['### Top eager modules', '', '| Path | Bytes |', '| --- | ---: |',
        ...(eager ? [`| leaf.mjs | ${leafBytes} |`, `| bridge.mjs | ${bridgeBytes} |`] : []),
        `| entry.mjs | ${entryBytes} |`, '', '### Unresolved dependencies'].join('\n');
      assert.ok(markdown.includes(table), 'exact top eager table');
      assert.ok(markdown.includes('Static source bytes do not establish a performance win or verify production.'));
      assert.equal(readFileSync(entryPath, 'utf8'), source);
      assert.equal(readFileSync(bridgePath, 'utf8'), bridge);
      assert.equal(readFileSync(leafPath, 'utf8'), leaf);
      return markdown;
    }

    const original = phase(staticEntry, true);
    phase(dynamicEntry, false);
    assert.equal(phase(staticEntry, true), original, 'restored summary matches byte for byte');
    assert.equal(existsSync(sentinel), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
