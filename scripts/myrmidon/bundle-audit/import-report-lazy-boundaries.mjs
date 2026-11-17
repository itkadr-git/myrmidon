#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const fail = category => { throw category; };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' && value.length > 0;
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function boundaries(report) {
  if (!object(report) || !name(report.entry) || !Array.isArray(report.modules) || !report.modules.length || !Array.isArray(report.edges)) fail('shape');
  const modules = new Map(), outgoing = new Map(), edges = new Set();
  for (const mod of report.modules) {
    if (!object(mod) || !name(mod.path) || !Number.isSafeInteger(mod.bytes) || mod.bytes < 0 || typeof mod.eager !== 'boolean') fail('shape');
    if (modules.has(mod.path)) fail('graph');
    modules.set(mod.path, mod);
  }
  if (!modules.has(report.entry)) fail('graph');
  for (const edge of report.edges) {
    if (!object(edge) || !name(edge.from) || typeof edge.specifier !== 'string' || !['eager', 'lazy'].includes(edge.kind) || !(edge.to === null || name(edge.to))) fail('shape');
    if (!modules.has(edge.from) || (edge.to !== null && !modules.has(edge.to))) fail('graph');
    const key = JSON.stringify([edge.from, edge.specifier, edge.kind, edge.to]);
    if (edges.has(key)) fail('graph');
    edges.add(key);
    if (edge.kind === 'eager' && edge.to !== null) {
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
      outgoing.get(edge.from).push(edge.to);
    }
  }
  const eager = new Set([report.entry]), queue = [report.entry];
  for (let i = 0; i < queue.length; i++) {
    for (const to of outgoing.get(queue[i]) ?? []) {
      if (!eager.has(to)) { eager.add(to); queue.push(to); }
    }
  }
  for (const mod of modules.values()) if (mod.eager !== eager.has(mod.path)) fail('graph');
  const closureBytes = new Map();
  function bytesFor(target) {
    if (closureBytes.has(target)) return closureBytes.get(target);
    const seen = new Set([target]), pending = [target];
    let bytes = 0;
    for (let i = 0; i < pending.length; i++) {
      const path = pending[i];
      bytes += modules.get(path).bytes;
      for (const to of outgoing.get(path) ?? []) {
        if (!eager.has(to) && !seen.has(to)) { seen.add(to); pending.push(to); }
      }
    }
    closureBytes.set(target, bytes);
    return bytes;
  }
  const result = report.edges.filter(edge => edge.kind === 'lazy' && edge.to !== null && eager.has(edge.from) && !eager.has(edge.to))
    .map(edge => ({ from: edge.from, specifier: edge.specifier, to: edge.to, bytes: bytesFor(edge.to) }));
  result.sort((a, b) => cmp(a.from, b.from) || cmp(a.specifier, b.specifier) || cmp(a.to, b.to));
  return { entry: report.entry, boundaries: result };
}

try {
  if (process.argv.length !== 3) fail('argv');
  let input, report;
  try { input = readFileSync(process.argv[2] === '-' ? 0 : process.argv[2], 'utf8'); } catch { fail('file'); }
  try { report = JSON.parse(input); } catch { fail('json'); }
  process.stdout.write(`${JSON.stringify(boundaries(report))}\n`);
} catch (error) {
  process.stderr.write(`${['argv', 'file', 'json', 'shape', 'graph'].includes(error) ? error : 'graph'}\n`);
  process.exitCode = 1;
}
