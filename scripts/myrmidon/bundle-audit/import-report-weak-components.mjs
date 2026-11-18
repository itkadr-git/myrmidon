#!/usr/bin/env node
// Usage: node /absolute/path/import-report-weak-components.mjs eager|all < report.json
// stdin: {entry, modules: [{path, bytes, eager}], edges: [{from, specifier, kind, to}]}.
// stdout: {entry, components: [{id, paths, bytes}]}; eager excludes lazy edges,
// all includes them, and null destinations do not add vertices.
// Errors exit 1 with empty stdout and one stderr category: argv, json, shape, or graph.
import { readFileSync } from 'node:fs';

const fail = category => { throw category; };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' && value.length > 0;

function components(report, mode) {
  if (!object(report) || !name(report.entry) || !Array.isArray(report.modules) || !report.modules.length || !Array.isArray(report.edges)) fail('shape');
  const modules = new Map(), neighbors = new Map();
  for (const mod of report.modules) {
    if (!object(mod) || !name(mod.path) || !Number.isSafeInteger(mod.bytes) || mod.bytes < 0 || typeof mod.eager !== 'boolean') fail('shape');
    if (modules.has(mod.path)) fail('graph');
    modules.set(mod.path, mod);
    neighbors.set(mod.path, []);
  }
  if (!modules.has(report.entry)) fail('graph');
  const seenEdges = new Set();
  for (const edge of report.edges) {
    if (!object(edge) || !name(edge.from) || typeof edge.specifier !== 'string' || !['eager', 'lazy'].includes(edge.kind) || !(edge.to === null || name(edge.to))) fail('shape');
    if (!modules.has(edge.from) || (edge.to !== null && !modules.has(edge.to))) fail('graph');
    const key = JSON.stringify([edge.from, edge.specifier, edge.kind, edge.to]);
    if (seenEdges.has(key)) fail('graph');
    seenEdges.add(key);
    if (edge.to !== null && (mode === 'all' || edge.kind === 'eager')) {
      neighbors.get(edge.from).push(edge.to);
      neighbors.get(edge.to).push(edge.from);
    }
  }
  const seen = new Set(), result = [];
  for (const start of [...modules.keys()].sort()) {
    if (seen.has(start)) continue;
    const paths = [], queue = [start];
    let bytes = 0;
    seen.add(start);
    for (let i = 0; i < queue.length; i++) {
      const path = queue[i];
      paths.push(path);
      bytes += modules.get(path).bytes;
      if (!Number.isSafeInteger(bytes)) fail('graph');
      for (const next of neighbors.get(path)) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    paths.sort();
    result.push({ id: paths[0], paths, bytes });
  }
  return { entry: report.entry, components: result };
}

try {
  if (process.argv.length !== 3 || !['eager', 'all'].includes(process.argv[2])) fail('argv');
  let report;
  try { report = JSON.parse(readFileSync(0, 'utf8')); } catch { fail('json'); }
  process.stdout.write(`${JSON.stringify(components(report, process.argv[2]))}\n`);
} catch (error) {
  process.stderr.write(`${['argv', 'json', 'shape', 'graph'].includes(error) ? error : 'graph'}\n`);
  process.exitCode = 1;
}
