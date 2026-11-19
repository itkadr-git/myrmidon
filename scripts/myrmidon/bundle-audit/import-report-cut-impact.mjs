#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const fail = category => { throw category; };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' && value.length > 0;

function parseReport(report) {
  if (!object(report) || !string(report.entry) || !Array.isArray(report.modules) || report.modules.length === 0 || !Array.isArray(report.edges)) fail('shape');
  const modules = new Map();
  for (const module of report.modules) {
    if (!object(module) || !string(module.path) || !Number.isSafeInteger(module.bytes) || module.bytes < 0 || typeof module.eager !== 'boolean') fail('shape');
    if (modules.has(module.path)) fail('graph');
    modules.set(module.path, module);
  }
  if (!modules.has(report.entry)) fail('graph');

  const outgoing = new Map();
  const seen = new Set();
  for (const edge of report.edges) {
    if (!object(edge) || !string(edge.from) || typeof edge.specifier !== 'string' || !['eager', 'lazy'].includes(edge.kind) || !(edge.to === null || string(edge.to))) fail('shape');
    if (!modules.has(edge.from) || (edge.to !== null && !modules.has(edge.to))) fail('graph');
    const key = JSON.stringify([edge.from, edge.specifier, edge.kind, edge.to]);
    if (seen.has(key)) fail('graph');
    seen.add(key);
    if (edge.kind === 'eager' && edge.to !== null) {
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
      outgoing.get(edge.from).push(edge.to);
    }
  }

  return { modules, outgoing };
}

function closure(root, outgoing, removed) {
  if (root === removed) return new Set();
  const seen = new Set();
  const pending = [root];
  while (pending.length) {
    const path = pending.pop();
    if (path === removed || seen.has(path)) continue;
    seen.add(path);
    for (const next of outgoing.get(path) ?? []) if (next !== removed) pending.push(next);
  }
  return seen;
}

function analyze(report, removed) {
  const { modules, outgoing } = parseReport(report);
  if (!modules.has(removed)) fail('argv');
  const baseline = closure(report.entry, outgoing, null);
  const remaining = closure(report.entry, outgoing, removed);
  const lostPaths = [...baseline].filter(path => !remaining.has(path)).sort();
  let lostBytes = 0;
  for (const path of lostPaths) {
    lostBytes += modules.get(path).bytes;
    if (!Number.isSafeInteger(lostBytes)) fail('graph');
  }
  return { entry: report.entry, removed, lostPaths, lostBytes };
}

try {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !string(args[0])) fail('argv');
  let report;
  try { report = JSON.parse(readFileSync(0, 'utf8')); } catch { fail('json'); }
  process.stdout.write(`${JSON.stringify(analyze(report, args[0]))}\n`);
} catch (error) {
  process.stderr.write(`${['argv', 'json', 'shape', 'graph'].includes(error) ? error : 'graph'}\n`);
  process.exitCode = 1;
}
