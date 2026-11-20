#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const fail = category => { throw category; };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' && value.length > 0;

function reverseImpact(report, target) {
  if (!object(report) || !name(report.entry) || !Array.isArray(report.modules) || !report.modules.length || !Array.isArray(report.edges)) fail('shape');
  const modules = new Map();
  for (const mod of report.modules) {
    if (!object(mod) || !name(mod.path) || !Number.isSafeInteger(mod.bytes) || mod.bytes < 0 || typeof mod.eager !== 'boolean') fail('shape');
    if (modules.has(mod.path)) fail('graph');
    modules.set(mod.path, mod);
  }
  if (!modules.has(report.entry) || !modules.has(target)) fail('graph');
  const outgoing = new Map(), incoming = new Map(), seen = new Set();
  for (const edge of report.edges) {
    if (!object(edge) || !name(edge.from) || typeof edge.specifier !== 'string' || !['eager', 'lazy'].includes(edge.kind) || !(edge.to === null || name(edge.to))) fail('shape');
    if (!modules.has(edge.from) || (edge.to !== null && !modules.has(edge.to))) fail('graph');
    const key = JSON.stringify([edge.from, edge.specifier, edge.kind, edge.to]);
    if (seen.has(key)) fail('graph');
    seen.add(key);
    if (edge.kind === 'eager' && edge.to !== null) {
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
      if (!incoming.has(edge.to)) incoming.set(edge.to, []);
      outgoing.get(edge.from).push(edge.to);
      incoming.get(edge.to).push(edge.from);
    }
  }
  const reachable = new Set([report.entry]), queue = [report.entry];
  for (let i = 0; i < queue.length; i++) {
    for (const next of outgoing.get(queue[i]) ?? []) {
      if (!reachable.has(next)) { reachable.add(next); queue.push(next); }
    }
  }
  for (const [path, mod] of modules) if (mod.eager !== reachable.has(path)) fail('graph');
  const distance = new Map([[target, 0]]), pending = [target];
  for (let i = 0; i < pending.length; i++) {
    for (const importer of incoming.get(pending[i]) ?? []) {
      if (!distance.has(importer)) { distance.set(importer, distance.get(pending[i]) + 1); pending.push(importer); }
    }
  }
  const importers = [...distance].filter(([path]) => path !== target).map(([path, distance]) => ({ path, distance }));
  importers.sort((a, b) => a.distance - b.distance || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entry: report.entry, target, importers };
}

try {
  if (process.argv.length !== 4 || !name(process.argv[2]) || !name(process.argv[3])) fail('argv');
  let contents, report;
  try { contents = readFileSync(process.argv[2] === '-' ? 0 : process.argv[2], 'utf8'); } catch { fail('file'); }
  try { report = JSON.parse(contents); } catch { fail('json'); }
  process.stdout.write(`${JSON.stringify(reverseImpact(report, process.argv[3]))}\n`);
} catch (error) {
  process.stderr.write(`${['argv', 'file', 'json', 'shape', 'graph'].includes(error) ? error : 'graph'}\n`);
  process.exitCode = 1;
}
