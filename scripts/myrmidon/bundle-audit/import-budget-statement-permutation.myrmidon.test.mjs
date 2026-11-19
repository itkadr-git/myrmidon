import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();

test('statement permutations preserve the startup graph; changing an import changes eager reachability', () => {
  const dir = mkdtempSync(join(scratch, 'import-permutation-'));
  try {
    const marker = join(dir, 'executed');
    const statements = [
      "import './a.mjs'; ",
      "export * from './b.mjs';",
      "require('./b.mjs');",
      "import('./lazy.mjs');",
    ];
    const negative = "import('./a.mjs');";
    assert.equal(Buffer.byteLength(statements[0]), Buffer.byteLength(negative));
    const fixed = `\nconst text = "import './fake.mjs'";\nconst pattern = /require\\('fake'\\)/;\nconst template = \`import('fake')\`;\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');\n`;
    const sources = {
      'a.mjs': "import './lazy.mjs';\n",
      'b.mjs': "export * from './lazy.mjs';\n",
      'lazy.mjs': "import './entry.mjs';\n",
    };
    for (const [name, source] of Object.entries(sources)) writeFileSync(join(dir, name), source);
    const entrySource = order => order.map(i => statements[i]).join('\n') + fixed;
    const entryBytes = Buffer.byteLength(entrySource([0, 1, 2, 3]));
    const sizes = { 'a.mjs': Buffer.byteLength(sources['a.mjs']), 'b.mjs': Buffer.byteLength(sources['b.mjs']), 'entry.mjs': entryBytes, 'lazy.mjs': Buffer.byteLength(sources['lazy.mjs']) };
    const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
    const expectedEdges = [
      edge('a.mjs', './lazy.mjs', 'eager', 'lazy.mjs'),
      edge('b.mjs', './lazy.mjs', 'eager', 'lazy.mjs'),
      edge('entry.mjs', './a.mjs', 'eager', 'a.mjs'),
      edge('entry.mjs', './b.mjs', 'eager', 'b.mjs'),
      edge('entry.mjs', './lazy.mjs', 'lazy', 'lazy.mjs'),
      edge('lazy.mjs', './entry.mjs', 'eager', 'entry.mjs'),
    ];
    const expectedReport = isNegative => {
      const a = { path: 'a.mjs', bytes: sizes['a.mjs'], eager: !isNegative };
      const b = { path: 'b.mjs', bytes: sizes['b.mjs'], eager: true };
      const entry = { path: 'entry.mjs', bytes: sizes['entry.mjs'], eager: true };
      const lazy = { path: 'lazy.mjs', bytes: sizes['lazy.mjs'], eager: true };
      const total = sizes['a.mjs'] + sizes['b.mjs'] + sizes['entry.mjs'] + sizes['lazy.mjs'];
      return {
        entry: 'entry.mjs', modules: [a, b, entry, lazy],
        edges: isNegative ? [expectedEdges[0], expectedEdges[1], { ...expectedEdges[2], kind: 'lazy' }, ...expectedEdges.slice(3)] : expectedEdges,
        unknown: [], counts: { modules: 4, eagerModules: isNegative ? 3 : 4, edges: 6 },
        bytes: { total, eager: total - (isNegative ? sizes['a.mjs'] : 0) },
        heaviestEager: [entry, b, lazy, ...(!isNegative ? [a] : [])],
      };
    };
    const run = source => {
      assert.equal(Buffer.byteLength(source), entryBytes);
      writeFileSync(join(dir, 'entry.mjs'), source);
      const result = spawnSync(process.execPath, [cli, join(dir, 'entry.mjs')], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(existsSync(marker), false);
      return result.stdout;
    };
    const orders = [[0, 1, 2, 3], [1, 0, 3, 2], [2, 3, 0, 1], [3, 2, 1, 0], [1, 2, 3, 0], [3, 0, 2, 1]];
    const baseline = run(entrySource(orders[0]));
    assert.deepEqual(JSON.parse(baseline), expectedReport(false));
    for (const order of orders.slice(1)) assert.equal(run(entrySource(order)), baseline, `order ${order}`);
    const control = entrySource(orders[0]).replace(statements[0], negative);
    assert.deepEqual(JSON.parse(run(control)), expectedReport(true));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
