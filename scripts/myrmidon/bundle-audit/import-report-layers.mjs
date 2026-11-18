#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const fail = category => { throw category; };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' && value.length > 0;

function layers(report) {
  if (!object(report) || !name(report.entry) || !Array.isArray(report.modules) || !report.modules.length || !Array.isArray(report.edges)) fail('shape');
  const modules = new Map();
  for (const mod of report.modules) {
    if (!object(mod) || !name(mod.path) || !Number.isSafeInteger(mod.bytes) || mod.bytes < 0 || typeof mod.eager !== 'boolean') fail('shape');
    if (modules.has(mod.path)) fail('graph');
    modules.set(mod.path, mod);
  }
  if (!modules.has(report.entry)) fail('graph');
  const outgoing = new Map(), seenEdges = new Set();
  for (const edge of report.edges) {
    if (!object(edge) || !name(edge.from) || typeof edge.specifier !== 'string' || !['eager', 'lazy'].includes(edge.kind) || !(edge.to === null || name(edge.to))) fail('shape');
    if (!modules.has(edge.from) || (edge.to !== null && !modules.has(edge.to))) fail('graph');
    const key = JSON.stringify([edge.from, edge.specifier, edge.kind, edge.to]);
    if (seenEdges.has(key)) fail('graph');
    seenEdges.add(key);
    if (edge.kind === 'eager' && edge.to !== null) {
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
      outgoing.get(edge.from).push(edge.to);
    }
  }
  const depths = new Map([[report.entry, 0]]), queue = [report.entry];
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i];
    for (const to of outgoing.get(from) ?? []) {
      if (!depths.has(to)) { depths.set(to, depths.get(from) + 1); queue.push(to); }
    }
  }
  const result = [], unreachable = [];
  for (const path of [...modules.keys()].sort()) {
    const mod = modules.get(path), depth = depths.get(path);
    if (mod.eager !== (depth !== undefined)) fail('graph');
    if (depth === undefined) { unreachable.push(path); continue; }
    if (!result[depth]) result[depth] = { depth, paths: [], bytes: 0 };
    const layer = result[depth];
    layer.paths.push(path);
    layer.bytes += mod.bytes;
    if (!Number.isSafeInteger(layer.bytes)) fail('graph');
  }
  return { entry: report.entry, layers: result, unreachable };
}

try {
  if (process.argv.length !== 2) fail('argv');
  let report;
  try { report = JSON.parse(readFileSync(0, 'utf8')); } catch { fail('json'); }
  process.stdout.write(`${JSON.stringify(layers(report))}\n`);
} catch (error) {
  process.stderr.write(`${['argv', 'json', 'shape', 'graph'].includes(error) ? error : 'graph'}\n`);
  process.exitCode = 1;
}
