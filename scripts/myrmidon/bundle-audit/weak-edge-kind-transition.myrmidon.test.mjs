import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const realConsumer = fileURLToPath(new URL('./import-report-weak-components.mjs', import.meta.url));

function run(cli, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.endsWith('\n'));
  return { raw: result.stdout, json: JSON.parse(result.stdout) };
}

test('rescans static to lazy to static edges without executing sources', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'weak-transition-'));
  try {
    const sentinel = join(dir, 'executed');
    const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('fixture executed');\n`;
    const initial = "import './bridge.mjs' ;\nimport('./island.mjs');\n" + guard;
    const lazy = "import('./bridge.mjs');\nimport('./island.mjs');\n" + guard;
    const sources = {
      'entry.mjs': initial,
      'bridge.mjs': "import './leaf.mjs';\n" + guard,
      'leaf.mjs': guard,
      'island.mjs': guard,
    };
    for (const [name, content] of Object.entries(sources)) writeFileSync(join(dir, name), content);
    let consumer = realConsumer;
    if (process.env.MYRMIDON_WEAK_TRANSITION_TEST_STALE === '1') {
      consumer = join(dir, 'stale-consumer.mjs');
      writeFileSync(consumer, `import { readFileSync, writeFileSync, existsSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nconst input = readFileSync(0, 'utf8');\nconst cache = ${JSON.stringify(join(dir, 'cache-'))} + process.argv[2];\nif (!existsSync(cache)) { const r = spawnSync(process.execPath, [${JSON.stringify(realConsumer)}, process.argv[2]], { input, encoding: 'utf8' }); if (r.status !== 0) process.exit(1); writeFileSync(cache, r.stdout); }\nprocess.stdout.write(readFileSync(cache));\n`);
    }
    const size = name => Buffer.byteLength(name === 'entry.mjs' ? readFileSync(join(dir, name), 'utf8') : sources[name], 'utf8');
    const component = paths => ({ id: paths[0], paths, bytes: paths.reduce((sum, path) => sum + size(path), 0) });
    const allPaths = ['bridge.mjs', 'entry.mjs', 'island.mjs', 'leaf.mjs'];
    const phase = kind => {
      const scanned = run(scanner, [join(dir, 'entry.mjs')]);
      assert.equal(existsSync(sentinel), false);
      assert.deepEqual(scanned.json.modules.map(m => m.path), allPaths);
      assert.deepEqual(scanned.json.edges.find(e => e.from === 'entry.mjs' && e.to === 'bridge.mjs'), {
        from: 'entry.mjs', specifier: './bridge.mjs', kind, to: 'bridge.mjs',
      });
      const eagerPaths = kind === 'eager'
        ? [['bridge.mjs', 'entry.mjs', 'leaf.mjs'], ['island.mjs']]
        : [['bridge.mjs', 'leaf.mjs'], ['entry.mjs'], ['island.mjs']];
      const results = {};
      for (const [mode, paths] of [['eager', eagerPaths], ['all', [allPaths]]]) {
        const result = run(consumer, [mode], scanned.raw).json;
        assert.equal(existsSync(sentinel), false);
        assert.deepEqual(result, { entry: 'entry.mjs', components: paths.map(component) });
        assert.deepEqual(result.components.flatMap(c => c.paths).sort(), allPaths);
        results[mode] = result;
      }
      return results;
    };
    const first = phase('eager');
    writeFileSync(join(dir, 'entry.mjs'), lazy);
    const middle = phase('lazy');
    assert.notDeepEqual(middle.eager, first.eager);
    assert.deepEqual(middle.all, first.all);
    writeFileSync(join(dir, 'entry.mjs'), initial);
    assert.deepEqual(phase('eager'), first);
    for (const [name, content] of Object.entries(sources)) assert.equal(readFileSync(join(dir, name), 'utf8'), content);
    assert.equal(existsSync(sentinel), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
