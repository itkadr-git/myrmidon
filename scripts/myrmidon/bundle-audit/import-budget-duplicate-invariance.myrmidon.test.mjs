import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-budget.mjs', import.meta.url).pathname;
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
const statements = [
  "import './a.mjs';\n",
  "require('./b.mjs');\n",
  "export * from './shared.mjs';\n",
  "import('./lazy.mjs');\n",
];
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const baseEdges = [
  edge('a.mjs', './shared.mjs', 'eager', 'shared.mjs'),
  edge('b.mjs', './shared.mjs', 'eager', 'shared.mjs'),
  edge('entry.mjs', './a.mjs', 'eager', 'a.mjs'),
  edge('entry.mjs', './a.mjs', 'lazy', 'a.mjs'),
  edge('entry.mjs', './b.mjs', 'eager', 'b.mjs'),
  edge('entry.mjs', './lazy.mjs', 'lazy', 'lazy.mjs'),
  edge('entry.mjs', './shared.mjs', 'eager', 'shared.mjs'),
  edge('shared.mjs', './entry.mjs', 'eager', 'entry.mjs'),
];

test('duplicate imports preserve the complete graph across CLI runs', () => {
  const dir = mkdtempSync(join(scratch, 'import-budget-duplicate-'));
  try {
    const marker = join(dir, 'executed');
    const run = (selected, copies, negative = false) => {
      const sources = {
        'a.mjs': "import './shared.mjs';\n",
        'b.mjs': `${negative ? "import './a.mjs';\n" : ''}import './shared.mjs';\n`,
        'entry.mjs': statements.map((s, i) => s.repeat(i === selected ? copies : 1)).join('') +
          `import('./a.mjs');\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');\n`,
        'lazy.mjs': 'export const lazy = 1;\n',
        'shared.mjs': "import './entry.mjs';\n",
      };
      for (const [name, source] of Object.entries(sources)) writeFileSync(join(dir, name), source);
      const result = spawnSync(process.execPath, [cli, join(dir, 'entry.mjs')], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(existsSync(marker), false);
      const modules = Object.entries(sources).map(([path, source]) => ({ path, bytes: Buffer.byteLength(source), eager: path !== 'lazy.mjs' }));
      const eager = modules.filter(module => module.eager);
      const expectedEdges = negative ? [baseEdges[0], edge('b.mjs', './a.mjs', 'eager', 'a.mjs'), ...baseEdges.slice(1)] : baseEdges;
      const expected = {
        entry: 'entry.mjs', modules, edges: expectedEdges, unknown: [],
        counts: { modules: 5, eagerModules: 4, edges: negative ? 9 : 8 },
        bytes: { total: modules.reduce((sum, module) => sum + module.bytes, 0), eager: eager.reduce((sum, module) => sum + module.bytes, 0) },
        heaviestEager: [...eager].sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      };
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report, expected, `statement ${selected}, copies ${copies}, negative ${negative}`);
      return report;
    };
    const baseline = run(0, 1);
    for (let selected = 0; selected < statements.length; selected++) {
      for (const copies of [1, 2, 7]) {
        const report = run(selected, copies);
        assert.deepEqual(report.edges, baseline.edges);
        assert.deepEqual(report.modules.map(({ path, eager }) => ({ path, eager })), baseline.modules.map(({ path, eager }) => ({ path, eager })));
        assert.deepEqual(report.counts, baseline.counts);
      }
    }
    const negative = run(0, 1, true);
    assert.equal(negative.counts.edges, baseline.counts.edges + 1);
    assert.deepEqual(negative.edges.filter(e => !baseline.edges.some(original => JSON.stringify(original) === JSON.stringify(e))), [edge('b.mjs', './a.mjs', 'eager', 'a.mjs')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
