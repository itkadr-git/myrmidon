import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-budget.mjs', import.meta.url).pathname;

test('CLI reports eager graph, lazy edges, unknowns, and never executes input', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || tmpdir(), 'import-budget-'));
  try {
    const put = (name, text) => writeFileSync(join(dir, name), text);
    put('entry.mjs', `import './a.mjs'; import './a.mjs'; export {x} from './b.mjs';
      import('lazy-package'); import('./lazy.mjs'); require('./missing.js');
      import 'node:fs'; import 'uninstalled-package';
      // import './fake1.js';
      const text = "require('./fake2.js')";
      require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'executed'))}, 'bad');`);
    put('a.mjs', "import './entry.mjs'; export const x = 1;");
    put('b.mjs', 'export const x = 2;');
    put('lazy.mjs', "import './lazy-child.mjs';");
    put('lazy-child.mjs', 'export default 1;');
    const run = () => spawnSync(process.execPath, [cli, join(dir, 'entry.mjs')], { encoding: 'utf8' });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, run().stdout);
    const report = JSON.parse(first.stdout);
    assert.equal(existsSync(join(dir, 'executed')), false);
    assert.deepEqual(report.modules.filter(m => m.eager).map(m => m.path), ['a.mjs', 'b.mjs', 'entry.mjs']);
    assert.deepEqual(report.modules.filter(m => !m.eager).map(m => m.path), ['lazy-child.mjs', 'lazy.mjs']);
    assert.equal(report.edges.filter(e => e.from === 'entry.mjs' && e.specifier === './a.mjs').length, 1);
    assert.equal(report.edges.find(e => e.specifier === './lazy.mjs').kind, 'lazy');
    assert.deepEqual(report.unknown.map(e => e.specifier), ['./missing.js', 'lazy-package', 'uninstalled-package']);
    assert.equal(report.counts.eagerModules, 3);
    assert.equal(report.bytes.eager, report.modules.filter(m => m.eager).reduce((n, m) => n + m.bytes, 0));
    assert.equal(report.heaviestEager.length, 3);
    assert.ok(!first.stdout.includes('fake1.js') && !first.stdout.includes('fake2.js'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
