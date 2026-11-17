import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));

test('unreachable trees do not change the CLI budget, but connecting one does', (t) => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'import-budget-tree-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name, source) => writeFileSync(join(dir, name), source);
  const marker = join(dir, 'executed');
  const entry = `import './eager.mjs';\nimport('./lazy.mjs');\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`;
  const connection = "import './extra/heavy.mjs';\n";
  const eager = 'export const eager = true;\n';
  const lazy = 'export const lazy = true;\n';
  const heavy = `import './cycle.mjs';\nimport 'bare-heavy';\nexport const payload = '${'\u754c'.repeat(4096)}';\n//# sourceMappingURL=heavy.mjs.map\n`;
  const cycle = "import './heavy.mjs';\nimport 'bare-cycle';\n";
  const size = (text) => Buffer.byteLength(text, 'utf8');
  const module = (path, source, isEager) => ({ path, bytes: size(source), eager: isEager });
  const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
  const eagerEdge = edge('entry.mjs', './eager.mjs', 'eager', 'eager.mjs');
  const lazyEdge = edge('entry.mjs', './lazy.mjs', 'lazy', 'lazy.mjs');
  const connectionEdge = edge('entry.mjs', './extra/heavy.mjs', 'eager', 'extra/heavy.mjs');
  const cycleEdge = edge('extra/cycle.mjs', './heavy.mjs', 'eager', 'extra/heavy.mjs');
  const heavyEdge = edge('extra/heavy.mjs', './cycle.mjs', 'eager', 'extra/cycle.mjs');
  const cycleUnknown = edge('extra/cycle.mjs', 'bare-cycle', 'eager', null);
  const heavyUnknown = edge('extra/heavy.mjs', 'bare-heavy', 'eager', null);
  const eagerModule = module('eager.mjs', eager, true);
  const lazyModule = module('lazy.mjs', lazy, false);
  const entryModule = module('entry.mjs', entry, true);
  const connectedEntry = module('entry.mjs', entry + connection, true);
  const heavyModule = module('extra/heavy.mjs', heavy, true);
  const cycleModule = module('extra/cycle.mjs', cycle, true);
  // These explicit graphs are the fixture contract, not a traversal of scanner output.
  const baseline = {
    entry: 'entry.mjs', modules: [eagerModule, entryModule, lazyModule],
    edges: [eagerEdge, lazyEdge], unknown: [],
    counts: { modules: 3, eagerModules: 2, edges: 2 },
    bytes: { total: size(eager) + size(entry) + size(lazy), eager: size(eager) + size(entry) },
    heaviestEager: [entryModule, eagerModule],
  };
  const connected = {
    entry: 'entry.mjs', modules: [eagerModule, connectedEntry, cycleModule, heavyModule, lazyModule],
    edges: [eagerEdge, connectionEdge, lazyEdge, cycleEdge, cycleUnknown, heavyEdge, heavyUnknown],
    unknown: [cycleUnknown, heavyUnknown],
    counts: { modules: 5, eagerModules: 4, edges: 7 },
    bytes: { total: size(eager) + size(entry + connection) + size(cycle) + size(heavy) + size(lazy), eager: size(eager) + size(entry + connection) + size(cycle) + size(heavy) },
    heaviestEager: [heavyModule, connectedEntry, cycleModule, eagerModule],
  };
  const run = () => {
    const result = spawnSync(process.execPath, [cli, join(dir, 'entry.mjs')], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(existsSync(marker), false, 'scanner must not execute fixture source');
    return result.stdout;
  };

  put('entry.mjs', entry);
  put('eager.mjs', eager);
  put('lazy.mjs', lazy);
  const original = run();
  assert.deepEqual(JSON.parse(original), baseline);

  mkdirSync(join(dir, 'extra'));
  put('extra/heavy.mjs', heavy);
  put('extra/cycle.mjs', cycle);
  put('extra/heavy.mjs.map', JSON.stringify({ version: 3, sourcesContent: ["import 'map-only-package'; require('./phantom.mjs');"] }));
  const unreachable = run();
  assert.equal(unreachable, original);
  assert.deepEqual(JSON.parse(unreachable), baseline);

  put('entry.mjs', entry + connection);
  const reachable = run();
  assert.notEqual(reachable, original, 'negative control must detect a connected tree');
  assert.deepEqual(JSON.parse(reachable), connected);

  put('entry.mjs', entry);
  const restored = run();
  assert.equal(restored, original);
  assert.deepEqual(JSON.parse(restored), baseline);
});
