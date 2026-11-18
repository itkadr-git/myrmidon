import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const sources = {
  'entry.mjs': "import './a.mjs';\nimport './b.mjs';\nimport './nested';\nimport('unknown-package');\nimport('./lazy.mjs');\nrequire('node:fs').writeFileSync('executed', 'bad');\n",
  'a.mjs': 'export const a = 1;\n',
  'b.mjs': 'export const b = 2;\n',
  'nested/index.js': "import '../entry.mjs';\n",
  'lazy.mjs': "import './lazy-child.mjs';\n",
  'lazy-child.mjs': 'export default 3;\n',
};
const extra = '// extra bytes to change the ranking\n';
const length = name => Buffer.byteLength(sources[name]);
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });

function expected(changed) {
  const a = { path: 'a.mjs', bytes: length('a.mjs') + (changed ? Buffer.byteLength(extra) : 0), eager: true };
  const b = { path: 'b.mjs', bytes: length('b.mjs'), eager: true };
  const entry = { path: 'entry.mjs', bytes: length('entry.mjs'), eager: true };
  const lazyChild = { path: 'lazy-child.mjs', bytes: length('lazy-child.mjs'), eager: false };
  const lazy = { path: 'lazy.mjs', bytes: length('lazy.mjs'), eager: false };
  const nested = { path: 'nested/index.js', bytes: length('nested/index.js'), eager: true };
  const unknown = edge('entry.mjs', 'unknown-package', 'lazy', null);
  return {
    entry: 'entry.mjs',
    modules: [a, b, entry, lazyChild, lazy, nested],
    edges: [
      edge('entry.mjs', './a.mjs', 'eager', 'a.mjs'),
      edge('entry.mjs', './b.mjs', 'eager', 'b.mjs'),
      edge('entry.mjs', './lazy.mjs', 'lazy', 'lazy.mjs'),
      edge('entry.mjs', './nested', 'eager', 'nested/index.js'),
      unknown,
      edge('lazy.mjs', './lazy-child.mjs', 'eager', 'lazy-child.mjs'),
      edge('nested/index.js', '../entry.mjs', 'eager', 'entry.mjs'),
    ],
    unknown: [unknown],
    counts: { modules: 6, eagerModules: 4, edges: 7 },
    bytes: {
      total: a.bytes + b.bytes + entry.bytes + lazyChild.bytes + lazy.bytes + nested.bytes,
      eager: a.bytes + b.bytes + entry.bytes + nested.bytes,
    },
    heaviestEager: changed ? [entry, a, nested, b] : [entry, nested, a, b],
  };
}

test('creation order and cwd do not change the CLI audit; byte changes do', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache');
  mkdirSync(scratch, { recursive: true });
  const work = mkdtempSync(join(scratch, 'import-order-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const roots = [join(work, 'forward'), join(work, 'reverse')];
  for (const [index, root] of roots.entries()) {
    mkdirSync(root, { recursive: true });
    const files = Object.entries(sources);
    if (index) files.reverse();
    for (const [name, source] of files) {
      const path = join(root, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source);
    }
  }
  function audit(root, cwd) {
    const run = spawnSync(process.execPath, [cli, join(root, 'entry.mjs')], { cwd, encoding: 'utf8', timeout: 10000 });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    for (const fixtureRoot of roots) assert.equal(run.stdout.includes(fixtureRoot), false);
    assert.equal(existsSync(join(cwd, 'executed')), false);
    return JSON.parse(run.stdout);
  }
  const first = audit(roots[0], roots[0]);
  const second = audit(roots[1], roots[1]);
  assert.equal(length('a.mjs'), length('b.mjs'));
  assert.deepEqual(first, expected(false));
  assert.deepEqual(second, first);

  writeFileSync(join(roots[1], 'a.mjs'), sources['a.mjs'] + extra);
  const changed = audit(roots[1], roots[1]);
  assert.notDeepEqual(changed, first);
  assert.deepEqual(changed, expected(true));
});
