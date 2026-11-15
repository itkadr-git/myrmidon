import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const cli = fileURLToPath(new URL('./artifact-audit.mjs', import.meta.url));
function fixture(t, manifest, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'artifact-audit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function write(rel, text) { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
  write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
  write('packages/app/package.json', JSON.stringify({ name: 'app', ...manifest }));
  for (const [name, content] of Object.entries(files)) write(`packages/app/${name}`, content);
  return root;
}
function audit(root) { return spawnSync(process.execPath, [cli, root], { encoding: 'utf8' }); }

test('valid runtime targets, conditional exports and wildcards are read only', (t) => {
  const root = fixture(t, { main: './dist/index.js', bin: { app: './dist/cli.js' }, exports: { '.': { types: './missing.d.ts', import: './dist/index.js', require: './dist/index.cjs' }, './*': './dist/*.js' } }, { 'dist/index.js': '', 'dist/index.cjs': '', 'dist/cli.js': '' });
  const manifest = join(root, 'packages/app/package.json');
  const before = readFileSync(manifest, 'utf8');
  const result = audit(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS/);
  assert.equal(readFileSync(manifest, 'utf8'), before);
});

test('source TypeScript entries and missing dist entries fail', (t) => {
  const root = fixture(t, { main: './src/index.ts', exports: { '.': { import: './dist/missing.js' } } }, { 'src/index.ts': '' });
  const result = audit(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /src\/index\.ts/);
  assert.match(result.stderr, /dist\/missing\.js/);
});

test('types-only exports are not runtime entries', (t) => {
  const root = fixture(t, { exports: { '.': { types: './dist/missing.d.ts' } } });
  assert.equal(audit(root).status, 0);
});

test('rejects lexical escape, dangling and escaping symlinks', (t) => {
  const root = fixture(t, { main: '../../outside.js', bin: { broken: './dist/broken.js', escape: './dist/escape.js' } }, { 'dist/keep.js': '' });
  symlinkSync('missing.js', join(root, 'packages/app/dist/broken.js'));
  symlinkSync('/etc/passwd', join(root, 'packages/app/dist/escape.js'));
  const result = audit(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside\.js/);
  assert.match(result.stderr, /broken\.js/);
  assert.match(result.stderr, /escape\.js/);
});

test('wildcards with no matches and invalid workspace fail closed', (t) => {
  const root = fixture(t, { exports: { './*': './dist/*.js' } });
  assert.notEqual(audit(root).status, 0);
  assert.notEqual(audit(join(root, 'not-a-root')).status, 0);
});
