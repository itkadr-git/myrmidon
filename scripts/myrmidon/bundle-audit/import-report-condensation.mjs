#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const fail = category => { process.stderr.write(`${category}\n`); process.exit(1); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function validate(report) {
  if (!object(report) || !text(report.entry) || !Array.isArray(report.modules) || !Array.isArray(report.edges)) fail('shape');
  const paths = new Set();
  for (const module of report.modules) {
    if (!object(module) || !text(module.path) || !Number.isSafeInteger(module.bytes) || module.bytes < 0 || typeof module.eager !== 'boolean') fail('shape');
    if (paths.has(module.path)) fail('graph');
    paths.add(module.path);
  }
  if (!paths.has(report.entry)) fail('graph');
  const tuples = new Set();
  for (const edge of report.edges) {
    if (!object(edge) || !text(edge.from) || !text(edge.specifier) || !['eager', 'lazy'].includes(edge.kind) || !(edge.to === null || text(edge.to))) fail('shape');
    if (!paths.has(edge.from) || (edge.to !== null && !paths.has(edge.to))) fail('graph');
    const tuple = JSON.stringify([edge.from, edge.specifier, edge.kind, edge.to]);
    if (tuples.has(tuple)) fail('graph');
    tuples.add(tuple);
  }
}

function condensation(report, mode) {
  const forward = new Map(report.modules.map(m => [m.path, new Set()]));
  const reverse = new Map(report.modules.map(m => [m.path, new Set()]));
  const sizes = new Map(report.modules.map(m => [m.path, m.bytes]));
  for (const edge of report.edges) {
    if (edge.to === null || (mode === 'eager' && edge.kind !== 'eager')) continue;
    forward.get(edge.from).add(edge.to);
    reverse.get(edge.to).add(edge.from);
  }
  // Iterative Kosaraju avoids recursion limits on large import graphs.
  const visited = new Set(), order = [];
  for (const start of forward.keys()) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack = [[start, forward.get(start).values()]];
    while (stack.length) {
      const top = stack[stack.length - 1], next = top[1].next();
      if (next.done) { order.push(top[0]); stack.pop(); }
      else if (!visited.has(next.value)) { visited.add(next.value); stack.push([next.value, forward.get(next.value).values()]); }
    }
  }
  visited.clear();
  const components = [], owner = new Map();
  while (order.length) {
    const start = order.pop();
    if (visited.has(start)) continue;
    const paths = [], stack = [start];
    visited.add(start);
    while (stack.length) {
      const path = stack.pop(); paths.push(path);
      for (const next of reverse.get(path)) if (!visited.has(next)) { visited.add(next); stack.push(next); }
    }
    paths.sort(cmp);
    let bytes = 0;
    for (const path of paths) {
      bytes += sizes.get(path);
      if (!Number.isSafeInteger(bytes)) fail('graph');
      owner.set(path, paths[0]);
    }
    components.push({ id: paths[0], paths, bytes });
  }
  components.sort((a, b) => cmp(a.id, b.id));
  const unique = new Map();
  for (const [from, targets] of forward) for (const to of targets) {
    const a = owner.get(from), b = owner.get(to);
    if (a !== b) unique.set(JSON.stringify([a, b]), { from: a, to: b });
  }
  const edges = [...unique.values()].sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to));
  return { entry: report.entry, components, edges };
}

if (process.argv.length !== 3 || !['eager', 'all'].includes(process.argv[2])) fail('argv');
let report;
try { report = JSON.parse(readFileSync(0, 'utf8')); } catch { fail('json'); }
validate(report);
process.stdout.write(`${JSON.stringify(condensation(report, process.argv[2]))}\n`);
