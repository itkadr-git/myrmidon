#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const fail = category => { throw category; };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' && value.length > 0;

function sinks(report) {
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
  const reached = new Set([report.entry]), queue = [report.entry];
  for (let i = 0; i < queue.length; i++) {
    for (const to of outgoing.get(queue[i]) ?? []) {
      if (!reached.has(to)) { reached.add(to); queue.push(to); }
    }
  }
  const result = [];
  let sinkBytes = 0;
  for (const path of [...reached].sort()) {
    if (outgoing.has(path)) continue;
    const bytes = modules.get(path).bytes;
    sinkBytes += bytes;
    if (!Number.isSafeInteger(sinkBytes)) fail('graph');
    result.push({ path, bytes });
  }
  return { entry: report.entry, sinks: result, sinkBytes };
}

try {
  if (process.argv.length !== 2) fail('argv');
  let report;
  try { report = JSON.parse(readFileSync(0, 'utf8')); } catch { fail('json'); }
  process.stdout.write(`${JSON.stringify(sinks(report))}\n`);
} catch (error) {
  process.stderr.write(`${['argv', 'json', 'shape', 'graph'].includes(error) ? error : 'graph'}\n`);
  process.exitCode = 1;
}
