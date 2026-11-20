import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));

test('CLI accounts for UTF-8 bytes, eager closure, deduplicated edges and deterministic top ten', () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(scratch, 'import-budget-accounting-'));
  try {
    const marker = join(dir, 'executed');
    const guard = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`;
    const sources = {
      'entry.mjs': "import './cycle.mjs'; import './cycle.mjs'; import './shared.mjs'; import('./shared.mjs'); import('./lazy.mjs');\n" +
        Array.from({ length: 11 }, (_, i) => `import './leaf${String(i).padStart(2, '0')}.mjs';`).join('\n') + '\n' + guard,
      'cycle.mjs': "import './entry.mjs'; import './shared.mjs';\n" + guard,
      'shared.mjs': "export const message = '\u00e9\u6f22';\n" + guard,
      'lazy.mjs': "import './lazy-child.mjs'; import './shared.mjs';\n" + guard,
      'lazy-child.mjs': 'export const lazy = true;\n' + guard,
      ...Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`leaf${String(i).padStart(2, '0')}.mjs`, 'export const leaf = 1;\n' + guard])),
    };
    for (const [name, text] of Object.entries(sources)) writeFileSync(join(dir, name), text);
    const run = () => spawnSync(process.execPath, [cli, join(dir, 'entry.mjs')], { timeout: 10000 });
    const first = run();
    const second = run();
    for (const result of [first, second]) {
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr.toString());
      assert.equal(result.stderr.toString(), '');
    }
    assert.deepEqual(first.stdout, second.stdout);
    assert.equal(existsSync(marker), false);
    const report = JSON.parse(first.stdout.toString());
    const module = (path, eager) => ({ path, bytes: Buffer.byteLength(sources[path], 'utf8'), eager });
    const leaves = Array.from({ length: 11 }, (_, i) => `leaf${String(i).padStart(2, '0')}.mjs`);
    const modules = [module('cycle.mjs', true), module('entry.mjs', true), module('lazy-child.mjs', false), module('lazy.mjs', false), ...leaves.map(path => module(path, true)), module('shared.mjs', true)];
    const edge = (from, to, kind = 'eager') => ({ from, specifier: `./${to}`, kind, to });
    const edges = [edge('cycle.mjs', 'entry.mjs'), edge('cycle.mjs', 'shared.mjs'), edge('entry.mjs', 'cycle.mjs'), edge('entry.mjs', 'lazy.mjs', 'lazy'), ...leaves.map(path => edge('entry.mjs', path)), edge('entry.mjs', 'shared.mjs'), edge('entry.mjs', 'shared.mjs', 'lazy'), edge('lazy.mjs', 'lazy-child.mjs'), edge('lazy.mjs', 'shared.mjs')];
    const sum = paths => paths.reduce((total, path) => total + Buffer.byteLength(sources[path], 'utf8'), 0);
    assert.ok(Buffer.byteLength(sources['shared.mjs'], 'utf8') > sources['shared.mjs'].length);
    assert.deepEqual(report, {
      entry: 'entry.mjs', modules, edges, unknown: [],
      counts: { modules: 16, eagerModules: 14, edges: 19 },
      bytes: { total: sum(['cycle.mjs', 'entry.mjs', 'lazy-child.mjs', 'lazy.mjs', ...leaves, 'shared.mjs']), eager: sum(['cycle.mjs', 'entry.mjs', ...leaves, 'shared.mjs']) },
      heaviestEager: [module('entry.mjs', true), module('cycle.mjs', true), module('shared.mjs', true), ...leaves.slice(0, 7).map(path => module(path, true))],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
