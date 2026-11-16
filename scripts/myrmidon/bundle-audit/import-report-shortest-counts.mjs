#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isName = value => typeof value === 'string' && value.length > 0;
const fail = category => { throw new Error(category); };

function shortestCounts(report) {
  if (!isObject(report) || !isName(report.entry) || !Array.isArray(report.modules) || report.modules.length === 0 || !Array.isArray(report.edges)) fail('shape');

  const modules = new Map();
  for (const module of report.modules) {
    if (!isObject(module) || !isName(module.path) || !Number.isSafeInteger(module.bytes) || module.bytes < 0 || typeof module.eager !== 'boolean') fail('shape');
    if (modules.has(module.path)) fail('graph');
    modules.set(module.path, module);
  }
  if (!modules.has(report.entry)) fail('graph');

  const outgoing = new Map();
  const seenEdges = new Set();
  for (const edge of report.edges) {
    if (!isObject(edge) || !isName(edge.from) || typeof edge.specifier !== 'string' || !['eager', 'lazy'].includes(edge.kind) || !(edge.to === null || isName(edge.to))) fail('shape');
    if (!modules.has(edge.from) || (edge.to !== null && !modules.has(edge.to))) fail('graph');
    const key = JSON.stringify([edge.from, edge.specifier, edge.kind, edge.to]);
    if (seenEdges.has(key)) fail('graph');
    seenEdges.add(key);
    if (edge.kind === 'eager' && edge.to !== null) {
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, new Set());
      outgoing.get(edge.from).add(edge.to);
    }
  }

  const depths = new Map([[report.entry, 0]]);
  const counts = new Map([[report.entry, 1n]]);
  const queue = [report.entry];
  for (let index = 0; index < queue.length; index++) {
    const from = queue[index];
    for (const to of outgoing.get(from) ?? []) {
      if (!depths.has(to)) {
        depths.set(to, depths.get(from) + 1);
        counts.set(to, counts.get(from));
        queue.push(to);
      } else if (depths.get(to) === depths.get(from) + 1) {
        counts.set(to, counts.get(to) + counts.get(from));
      }
    }
  }

  const result = { entry: report.entry, modules: [], unreachable: [] };
  for (const path of [...modules.keys()].sort()) {
    const depth = depths.get(path);
    const module = modules.get(path);
    if (module.eager !== (depth !== undefined)) fail('graph');
    if (depth === undefined) result.unreachable.push(path);
    else result.modules.push({ path, depth, shortestPaths: counts.get(path).toString() });
  }
  return result;
}

try {
  if (process.argv.length !== 2) fail('argv');
  const input = readFileSync(0, 'utf8');
  let report;
  try { report = JSON.parse(input); } catch { fail('json'); }
  process.stdout.write(`${JSON.stringify(shortestCounts(report))}\n`);
} catch (error) {
  const category = error instanceof Error ? error.message : error;
  process.stderr.write(`${['argv', 'json', 'shape', 'graph'].includes(category) ? category : 'graph'}\n`);
  process.exitCode = 1;
}
