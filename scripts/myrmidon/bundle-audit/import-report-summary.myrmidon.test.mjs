import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-summary.mjs', import.meta.url));
const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const run = (input, args = []) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 10000 });
const report = (modules = [], edges = []) => ({ entry: 'entry.mjs', modules, edges, unknown: edges.filter(e => e.to === null), counts: { modules: modules.length, eagerModules: modules.filter(m => m.eager).length, edges: edges.length }, bytes: { total: modules.reduce((n,m) => n + m.bytes, 0), eager: modules.filter(m => m.eager).reduce((n,m) => n + m.bytes, 0) }, heaviestEager: [] });

test('formats empty report with explicit limits and disclaimer', () => {
  const result = run(JSON.stringify(report()));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /\| modules \| 0 \|/);
  assert.match(result.stdout, /\| eagerModules \| 0 \|/);
  assert.match(result.stdout, /\| totalBytes \| 0 \|/);
  assert.match(result.stdout, /\| eagerBytes \| 0 \|/);
  assert.match(result.stdout, /Omitted: 0/);
  assert.match(result.stdout, /not.*performance/i);
});

test('sorts and limits rows deterministically and escapes untrusted markdown', () => {
  const modules = Array.from({length: 12}, (_, i) => ({path: `file${String(i).padStart(2, '0')}`, bytes: 4, eager: true}));
  modules.push({path: 'evil|`<img src=x>&[x](https://bad)\r\n', bytes: 99, eager: true});
  const edges = Array.from({length: 51}, (_, i) => ({from: modules[0].path, specifier: `pkg${String(i).padStart(2, '0')}`, kind: 'eager', to: null}));
  edges[0].specifier = '<img>|`[bad](https://bad)&\n';
  const a = report(modules, edges), b = report([...modules].reverse(), [...edges].reverse());
  const first = run(JSON.stringify(a)), second = run(JSON.stringify(b));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.match(first.stdout, /&lt;img/);
  assert.match(first.stdout, /&#124;/);
  assert.match(first.stdout, /&#96;/);
  assert.match(first.stdout, /&amp;/);
  assert.doesNotMatch(first.stdout, /<img|\[bad\]\(https:/);
  assert.match(first.stdout, /Omitted: 1/);
  assert.match(first.stdout, /file08/);
  assert.doesNotMatch(first.stdout, /file09/);
  assert.match(first.stdout, /pkg49/);
  assert.doesNotMatch(first.stdout, /pkg50/);
});

test('rejects malformed JSON, invalid structure and inconsistent totals without echoing input', () => {
  const invalid = [ 'SECRET{', JSON.stringify({}), JSON.stringify({...report(), counts: {modules: 1, eagerModules: 0, edges: 0}}), JSON.stringify({...report(), bytes: {total: -1, eager: 0}}), JSON.stringify(report([{path:'x', bytes:1.5, eager:true}])), JSON.stringify(report([], [{from:'x', specifier:'SECRET', kind:'oops', to:null}])) ];
  for (const input of invalid) { const r = run(input); assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.match(r.stderr, /error/i); assert.doesNotMatch(r.stderr, /SECRET/); }
  const arg = run(JSON.stringify(report()), ['unexpected']); assert.equal(arg.status, 1); assert.equal(arg.stdout, '');
});

test('formats a real scanner report with UTF-8 bytes without changing or executing input', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || process.cwd(), 'summary-test-'));
  try {
    const entry = join(dir, 'entry.mjs'), marker = join(dir, 'executed');
    const source = `import 'missing-package';\n// \u00e9\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');\n`;
    writeFileSync(entry, source);
    const scan = spawnSync(process.execPath, [scanner, entry], {encoding:'utf8', timeout:10000});
    assert.equal(scan.status, 0, scan.stderr);
    const result = run(scan.stdout);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`\\| totalBytes \\| ${Buffer.byteLength(source)} \\|`));
    assert.match(result.stdout, /missing-package/);
    assert.equal(readFileSync(entry, 'utf8'), source);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
