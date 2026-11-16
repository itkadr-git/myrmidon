import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-lazy-boundaries.mjs', import.meta.url));
const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
const mod = (path, bytes, eager) => ({ path, bytes, eager });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const source = i => `source-${i}`;
const target = i => `target-${i}`;
const specifier = i => `./lazy-${i}`;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function check(t, report, expected) {
  const dir = mkdtempSync(join(scratchRoot, 'lazy-scale-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'report.json');
  for (const reversed of [false, true]) {
    const input = reversed ? { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() } : report;
    writeFileSync(path, JSON.stringify(input));
    const result = spawnSync(process.execPath, [cli, path], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, TMPDIR: dir },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
}

test('deep eager chain exposes the complete sorted lazy frontier', t => {
  const modules = [], edges = [], boundaries = [];
  for (let i = 0; i < 16000; i++) {
    modules.push(mod(source(i), i, true), mod(target(i), i % 7, false));
    if (i > 0) edges.push(edge(source(i - 1), `./next-${i}`, 'eager', source(i)));
    edges.push(edge(source(i), specifier(i), 'lazy', target(i)));
    boundaries.push({ from: source(i), specifier: specifier(i), to: target(i), bytes: i % 7 });
  }
  boundaries.sort((a, b) => compare(a.from, b.from) || compare(a.specifier, b.specifier) || compare(a.to, b.to));
  check(t, { entry: source(0), modules, edges }, { entry: source(0), boundaries });
});

test('frontier excludes eager targets and disconnected lazy sources', t => {
  const report = {
    entry: 'entry',
    modules: [mod('entry', 1, true), mod('eager', 2, true), mod('lazy', 0, false), mod('other', 4, false), mod('cycle-a', 5, false), mod('cycle-b', 6, false)],
    edges: [edge('entry', './eager', 'eager', 'eager'), edge('entry', './alternate', 'lazy', 'eager'), edge('entry', './lazy', 'lazy', 'lazy'), edge('lazy', './other', 'lazy', 'other'), edge('cycle-a', './b', 'eager', 'cycle-b'), edge('cycle-b', './a', 'eager', 'cycle-a'), edge('cycle-a', './other', 'lazy', 'other')],
  };
  check(t, report, { entry: 'entry', boundaries: [{ from: 'entry', specifier: './lazy', to: 'lazy', bytes: 0 }] });
});
