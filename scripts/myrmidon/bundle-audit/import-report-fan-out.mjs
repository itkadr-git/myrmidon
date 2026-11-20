#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const fail = category => { throw category; };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' && value.length > 0;

function fanOut(report) {
  if (!object(report) || !name(report.entry) || !Array.isArray(report.modules) || !report.modules.length || !Array.isArray(report.edges)) fail('shape');
  const modules = new Map();
  for (const mod of report.modules) {
    if (!object(mod) || !name(mod.path) || !Number.isSafeInteger(mod.bytes) || mod.bytes < 0 || typeof mod.eager !== 'boolean') fail('shape');
    if (modules.has(mod.path)) fail('graph');
    modules.set(mod.path, {path: mod.path, bytes: mod.bytes, targets: new Set()});
  }
  if (!modules.has(report.entry)) fail('graph');
  const seen = new Set();
  for (const edge of report.edges) {
    if (!object(edge) || !name(edge.from) || typeof edge.specifier !== 'string' || !['eager', 'lazy'].includes(edge.kind) || !(edge.to === null || name(edge.to))) fail('shape');
    if (!modules.has(edge.from) || (edge.to !== null && !modules.has(edge.to))) fail('graph');
    const key = JSON.stringify([edge.from, edge.specifier, edge.kind, edge.to]);
    if (seen.has(key)) fail('graph');
    seen.add(key);
    if (edge.kind === 'eager' && edge.to !== null) modules.get(edge.from).targets.add(edge.to);
  }
  const result = [...modules.values()].map(mod => {
    const targets = [...mod.targets].sort();
    if (!Number.isSafeInteger(targets.length)) fail('graph');
    return {path: mod.path, bytes: mod.bytes, targets, fanOut: targets.length};
  });
  result.sort((a, b) => b.fanOut - a.fanOut || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {entry: report.entry, modules: result};
}

try {
  if (process.argv.length !== 2) fail('argv');
  let report;
  try { report = JSON.parse(readFileSync(0, 'utf8')); } catch { fail('json'); }
  process.stdout.write(`${JSON.stringify(fanOut(report))}\n`);
} catch (error) {
  process.stderr.write(`${['argv', 'json', 'shape', 'graph'].includes(error) ? error : 'graph'}\n`);
  process.exitCode = 1;
}
