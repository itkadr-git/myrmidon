// Tests for vendor-share.mjs (node:test). The analysis runs against a
// throwaway git repository so the result does not depend on the CI checkout.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeVendorShare,
  calculateSimilarity,
  formatAsMarkdown,
  isExcluded,
  readVendorBaseCommit,
} from './vendor-share.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor-share.mjs');

function run(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function put(dir, rel, text) {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
}

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'vendor-share-'));
  run(dir, 'git', ['init', '-q']);
  run(dir, 'git', ['config', 'user.email', 't@example.com']);
  run(dir, 'git', ['config', 'user.name', 't']);
  put(dir, 'src/same.js', 'a\nb\nc\nd\n');
  put(dir, 'src/changed.js', 'a\nb\nc\nd\n');
  put(dir, 'node_modules/x/index.js', 'x\n');
  run(dir, 'git', ['add', '-A', '-f']);
  run(dir, 'git', ['commit', '-q', '-m', 'base']);
  const base = run(dir, 'git', ['rev-parse', 'HEAD']);
  put(dir, 'src/changed.js', 'one\ntwo\nthree\nfour\n');
  put(dir, 'src/new.js', 'brand new\n');
  put(dir, 'scripts/myrmidon/vendor-base.txt', `${base}\n\nprose after the hash\n`);
  run(dir, 'git', ['add', '-A', '-f']);
  run(dir, 'git', ['commit', '-q', '-m', 'ours']);
  return { dir, base };
}

test('calculateSimilarity', () => {
  assert.equal(calculateSimilarity('a\nb', 'a\nb'), 1);
  assert.equal(calculateSimilarity('a\nb', 'c\nd'), 0);
  assert.equal(calculateSimilarity(null, null), 1);
  assert.equal(calculateSimilarity('a', null), 0);
  assert.equal(calculateSimilarity('a\r\nb\n\n', 'a\nb'), 1);
  assert.equal(calculateSimilarity('a\nb\nc\nd', 'a\nb\nc\nx'), 0.75);
});

test('isExcluded', () => {
  assert.equal(isExcluded('node_modules/p/f.js'), true);
  assert.equal(isExcluded('a/b/node_modules/p/f.js'), true);
  assert.equal(isExcluded('dist/bundle.js'), true);
  assert.equal(isExcluded('pnpm-lock.yaml'), true);
  assert.equal(isExcluded('src/index.js'), false);
  assert.equal(isExcluded('src/a.js', ['src/*.js']), true);
  assert.equal(isExcluded('src/deep/a.js', ['src/*.js']), false);
});

test('readVendorBaseCommit takes the first token', () => {
  const { dir, base } = makeRepo();
  try {
    assert.equal(readVendorBaseCommit(dir), base);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyzeVendorShare splits vendor and own files', () => {
  const { dir } = makeRepo();
  try {
    const r = analyzeVendorShare({ cwd: dir });
    assert.deepEqual(r.details.vendorFiles.map((f) => f.path), ['src/same.js']);
    assert.deepEqual(r.details.nonVendorFiles.sort(), ['src/changed.js', 'src/new.js']);
    assert.equal(r.summary.totalFiles, 3);
    assert.equal(r.summary.vendorRatio, 1 / 3);
    const md = formatAsMarkdown(r);
    assert.ok(md.includes('# Vendor Share Analysis Report'));
    assert.ok(md.includes('| Total Files Analyzed | 3 |'));
    assert.ok(md.includes('| src | 1 |'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI prints JSON', () => {
  const { dir } = makeRepo();
  try {
    const r = spawnSync('node', [script, '--json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.summary.vendorFiles, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
