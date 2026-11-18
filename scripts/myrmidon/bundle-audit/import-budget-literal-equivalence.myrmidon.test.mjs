import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
const childSource = 'export const value = 1;\n';
const otherSource = 'export const value = 2;\n';
const forms = [
  ["'./child.mjs'", "'external-package'"],
  ['"./child.mjs"', '"external-package"'],
  [String.raw`'./ch\x69ld.mjs'`, String.raw`'ext\x65rnal-package'`],
  [String.raw`"./ch\u0069ld.mjs"`, String.raw`"ext\u0065rnal-package"`],
];
const syntaxes = [
  ['static import', literal => `import ${literal};`, 'eager'],
  ['export-from', literal => `export * from ${literal};`, 'eager'],
  ['require', literal => `require(${literal});`, 'eager'],
  ['dynamic import', literal => `import(${literal});`, 'lazy'],
];

for (const [name, statement, kind] of syntaxes) {
  test(`CLI preserves decoded graph across literal spellings: ${name}`, () => {
    const dir = mkdtempSync(join(scratch, 'literal-equivalence-'));
    try {
      const marker = join(dir, 'executed');
      writeFileSync(join(dir, 'child.mjs'), childSource);
      writeFileSync(join(dir, 'other.mjs'), otherSource);
      const run = (local, bare, target = 'child.mjs', duplicate = false) => {
        const source = `${statement(local)}\n${statement(bare)}\n${duplicate ? `${statement(forms[1][0])}\n${statement(forms[2][1])}\n` : ''}process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(marker)}, 'bad');\n`;
        writeFileSync(join(dir, 'entry.mjs'), source);
        const result = spawnSync(process.execPath, [cli, join(dir, 'entry.mjs')], { encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        assert.equal(existsSync(marker), false);
        const entryBytes = Buffer.byteLength(source);
        const targetBytes = Buffer.byteLength(target === 'child.mjs' ? childSource : otherSource);
        const eager = kind === 'eager';
        const localEdge = { from: 'entry.mjs', specifier: `./${target}`, kind, to: target };
        const bareEdge = { from: 'entry.mjs', specifier: 'external-package', kind, to: null };
        const entry = { path: 'entry.mjs', bytes: entryBytes, eager: true };
        const child = { path: target, bytes: targetBytes, eager };
        const modules = target === 'child.mjs' ? [child, entry] : [entry, child];
        const expected = {
          entry: 'entry.mjs', modules, edges: [localEdge, bareEdge], unknown: [bareEdge],
          counts: { modules: 2, eagerModules: eager ? 2 : 1, edges: 2 },
          bytes: { total: entryBytes + targetBytes, eager: entryBytes + (eager ? targetBytes : 0) },
          heaviestEager: eager ? [entry, child] : [entry],
        };
        const report = JSON.parse(result.stdout);
        assert.deepEqual(report, expected);
        return report;
      };
      const reports = forms.map(([local, bare]) => run(local, bare));
      for (const report of reports.slice(1)) {
        assert.deepEqual(report.edges, reports[0].edges);
        assert.deepEqual(report.unknown, reports[0].unknown);
        assert.deepEqual(report.modules.map(({ path, eager }) => ({ path, eager })), reports[0].modules.map(({ path, eager }) => ({ path, eager })));
      }
      const deduplicated = run(forms[0][0], forms[0][1], 'child.mjs', true);
      assert.deepEqual(deduplicated.edges, reports[0].edges);
      const changed = run("'./other.mjs'", forms[0][1], 'other.mjs');
      assert.notDeepEqual(changed.edges, reports[0].edges);
      assert.notDeepEqual(changed.modules.map(module => module.path), reports[0].modules.map(module => module.path));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
