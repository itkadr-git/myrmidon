import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = join(dir, 'import-report-cycles.mjs');
const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || join(process.env.HOME, '.cache');
const nodeCount = 12_000;
const moduleFor = path => ({ path, bytes: 0, eager: false });
const edge = (from, to, kind) => ({ from, to, kind, specifier: to || 'unknown' });
const modulePath = index => `module-${String(index).padStart(5, '0')}.mjs`;
const chainPaths = () => Array.from({ length: nodeCount }, (_, index) => modulePath(index));

function fixture(t) {
  const directory = mkdtempSync(join(scratchRoot, 'cycles-scale-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function reportFor(closureKind) {
  const chain = chainPaths();
  const disconnected = ['disconnected-00.mjs', 'disconnected-01.mjs'];
  const selfLoop = 'self-loop.mjs';
  const modules = [...chain, ...disconnected, selfLoop].map(moduleFor);
  const edges = [];
  for (let index = 0; index < chain.length - 1; index += 1) {
    edges.push(edge(chain[index], chain[index + 1], 'eager'));
  }
  if (closureKind) edges.push(edge(chain.at(-1), chain[0], closureKind));
  edges.push(edge(disconnected[0], disconnected[1], 'eager'));
  edges.push(edge(disconnected[1], disconnected[0], 'eager'));
  edges.push(edge(selfLoop, selfLoop, 'eager'));
  edges.push(edge(chain[0], null, 'lazy'));
  return { entry: chain[0], modules, edges };
}

function expectedFor(closureKind) {
  const chain = chainPaths();
  const disconnected = ['disconnected-00.mjs', 'disconnected-01.mjs'];
  const selfLoop = ['self-loop.mjs'];
  const eagerCycles = [disconnected, selfLoop];
  const allCycles = [...eagerCycles];
  if (closureKind === 'eager') allCycles.splice(1, 0, chain);
  if (closureKind === 'lazy') allCycles.splice(1, 0, chain);
  if (closureKind === 'eager') eagerCycles.splice(1, 0, chain);
  return { entry: chain[0], eagerCycles, allCycles };
}

function runReport(t, report, closureKind) {
  const inputPath = join(fixture(t), 'report.json');
  const input = JSON.stringify(report);
  writeFileSync(inputPath, input);
  const result = spawnSync(process.execPath, [cli, inputPath], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expectedFor(closureKind)) + '\n');
  assert.equal(readFileSync(inputPath, 'utf8'), input);
  return result.stdout;
}

test('reports no cycles for a 12,000-node DAG', t => {
  const chain = chainPaths();
  const report = {
    entry: chain[0],
    modules: chain.map(moduleFor),
    edges: chain.slice(1).map((path, index) => edge(chain[index], path, 'eager')),
  };
  const inputPath = join(fixture(t), 'dag.json');
  const input = JSON.stringify(report);
  writeFileSync(inputPath, input);
  const result = spawnSync(process.execPath, [cli, inputPath], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify({ entry: chain[0], eagerCycles: [], allCycles: [] }) + '\n');
  assert.equal(readFileSync(inputPath, 'utf8'), input);
});

test('handles disconnected cycles alongside a 12,000-node chain', t => {
  runReport(t, reportFor(null), null);
  runReport(t, reportFor('eager'), 'eager');
});

test('keeps a lazy chain out of eager cycles while retaining it in all cycles', t => {
  const report = reportFor('lazy');
  const output = runReport(t, report, 'lazy');
  assert.deepEqual(JSON.parse(output), expectedFor('lazy'));
  assert.deepEqual(JSON.parse(output).eagerCycles, [
    ['disconnected-00.mjs', 'disconnected-01.mjs'],
    ['self-loop.mjs'],
  ]);
});

test('produces byte-identical output when modules and edges are permuted', t => {
  const report = reportFor('eager');
  const originalOutput = runReport(t, report, 'eager');
  const permuted = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
  assert.equal(runReport(t, permuted, 'eager'), originalOutput);
});
