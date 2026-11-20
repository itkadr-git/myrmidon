import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { buildMigration } from './adm-migrate.mjs';

const cleanScannerPort = () => ({ clean: true, findings: [] });
const source = (name) => `migration_kind: reference\n# ${name}\n`;

function withFixture(run) {
  const scratch = mkdtempSync(join(tmpdir(), 'adm-walk-contract-'));
  const root = join(scratch, 'root');
  const put = (path, text = source(path)) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  try {
    put('CLAUDE.md', 'description: Root policy\n# Root\n');
    put('memory/MEMORY.md', '# Index\n');
    run({ root, scratch, put });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const migrate = (root) => buildMigration(root, { scan: cleanScannerPort });
const paths = (plan) => plan.manifest.map((entry) => entry.path);

test('manifest recursively sorts paths and preserves source hashes', () => withFixture(({ root, put }) => {
  put('memory/z.md');
  put('memory/branch/deep/b.md');
  put('memory/branch/a.md');
  const plan = migrate(root);
  assert.deepEqual(paths(plan), ['CLAUDE.md', 'memory/branch/a.md', 'memory/branch/deep/b.md', 'memory/z.md']);
  assert.equal(plan.manifest[2].hash, createHash('sha256').update(source('memory/branch/deep/b.md')).digest('hex'));
  assert.deepEqual(plan.items.map((item) => item.path), paths(plan));
}));

for (const hidden of ['.git', '.hidden', '_archive']) {
  for (const prefix of ['memory', 'memory/nested']) {
    test(`skips ${hidden} directory under ${prefix}`, () => withFixture(({ root, put }) => {
      put(`${prefix}/${hidden}/ignored.md`);
      put(`${prefix}/included.md`);
      const plan = migrate(root);
      assert.deepEqual(paths(plan), ['CLAUDE.md', `${prefix}/included.md`]);
      assert.deepEqual(plan.items.map((item) => item.path), paths(plan));
    }));
  }
}

test('skips hidden files at multiple depths', () => withFixture(({ root, put }) => {
  put('memory/.hidden.md');
  put('memory/deep/.hidden.md');
  put('memory/deep/visible.md');
  assert.deepEqual(paths(migrate(root)), ['CLAUDE.md', 'memory/deep/visible.md']);
}));

test('excludes non-markdown files at multiple depths', () => withFixture(({ root, put }) => {
  put('memory/ignored.txt');
  put('memory/deep/ignored.txt');
  put('memory/deep/visible.md');
  assert.deepEqual(paths(migrate(root)), ['CLAUDE.md', 'memory/deep/visible.md']);
}));

test('excludes MEMORY.md indexes at every depth', () => withFixture(({ root, put }) => {
  put('memory/deep/MEMORY.md');
  put('memory/deep/visible.md');
  const plan = migrate(root);
  assert.deepEqual(paths(plan), ['CLAUDE.md', 'memory/deep/visible.md']);
  assert.deepEqual(plan.items.map((item) => item.path), paths(plan));
}));

for (const kind of ['CLAUDE.md', 'memory', 'nested file', 'nested directory']) {
  test(`rejects symlink ${kind} before scanning external content`, () => withFixture(({ root, scratch, put }) => {
    const external = join(scratch, 'external');
    mkdirSync(external);
    writeFileSync(join(external, 'outside.md'), source('outside'));
    let link;
    let target;
    if (kind === 'CLAUDE.md') {
      link = join(root, 'CLAUDE.md');
      rmSync(link);
      target = join(external, 'outside.md');
    } else if (kind === 'memory') {
      link = join(root, 'memory');
      rmSync(link, { recursive: true });
      target = external;
    } else {
      put('memory/nested/inside.md');
      link = join(root, 'memory/nested/link' + (kind === 'nested file' ? '.md' : ''));
      target = kind === 'nested file' ? join(external, 'outside.md') : external;
    }
    symlinkSync(target, link);
    let scans = 0;
    const reads = [];
    const originalReadFileSync = fs.readFileSync;
    const originalReaddirSync = fs.readdirSync;
    const track = (path) => reads.push(fs.realpathSync(path));
    fs.readFileSync = function trackedRead(path, ...args) {
      track(path);
      return originalReadFileSync.call(this, path, ...args);
    };
    fs.readdirSync = function trackedDirectory(path, ...args) {
      track(path);
      return originalReaddirSync.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => buildMigration(root, { scan: () => { scans++; return cleanScannerPort(); } }), /Symlinks are not migration sources/);
    } finally {
      fs.readFileSync = originalReadFileSync;
      fs.readdirSync = originalReaddirSync;
      syncBuiltinESMExports();
    }
    assert.equal(scans, 0);
    assert.equal(reads.some((path) => path === fs.realpathSync(external) || path.startsWith(fs.realpathSync(external) + '/')), false, 'external content must not be read');
  }));
}

for (const missing of ['CLAUDE.md', 'memory']) {
  test(`fails closed when ${missing} is absent`, () => withFixture(({ root }) => {
    rmSync(join(root, missing), { recursive: true });
    assert.throws(() => migrate(root), { code: 'ENOENT' });
  }));
}
