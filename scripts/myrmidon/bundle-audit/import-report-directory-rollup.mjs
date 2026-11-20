#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const fail = category => { throw new Error(category); };
const text = value => typeof value === 'string' && value.length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validPath = value => text(value) && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..');

function rollup(report) {
  if (!object(report) || !text(report.entry) || !Array.isArray(report.modules) || !report.modules.length || !Array.isArray(report.edges)) fail('shape');
  const modules = new Map();
  for (const m of report.modules) {
    if (!object(m) || !validPath(m.path) || !Number.isSafeInteger(m.bytes) || m.bytes < 0 || typeof m.eager !== 'boolean') fail('shape');
    if (modules.has(m.path)) fail('graph');
    modules.set(m.path, m);
  }
  const edges = new Set(), adjacency = new Map();
  for (const e of report.edges) {
    if (!object(e) || !text(e.from) || typeof e.specifier !== 'string' || !['eager','lazy'].includes(e.kind) || !(e.to === null || text(e.to))) fail('shape');
    const key = JSON.stringify([e.from,e.specifier,e.kind,e.to]);
    if (edges.has(key)) fail('graph');
    edges.add(key);
    if (!modules.has(e.from) || (e.to !== null && !modules.has(e.to))) fail('graph');
    if (e.kind === 'eager' && e.to !== null) {
      if (!adjacency.has(e.from)) adjacency.set(e.from, []);
      adjacency.get(e.from).push(e.to);
    }
  }
  if (!modules.has(report.entry)) fail('graph');
  const visited = new Set(), pending = [report.entry];
  while (pending.length) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) || []) pending.push(next);
  }
  const directories = new Map();
  for (const m of modules.values()) {
    if (m.eager !== visited.has(m.path)) fail('graph');
    const slash = m.path.lastIndexOf('/'), directory = slash < 0 ? '.' : m.path.slice(0, slash);
    if (!directories.has(directory)) directories.set(directory, {directory, modules:0, eagerModules:0, totalBytes:0, eagerBytes:0});
    const row = directories.get(directory);
    row.modules++;
    row.totalBytes += m.bytes;
    if (m.eager) { row.eagerModules++; row.eagerBytes += m.bytes; }
    if (![row.modules,row.eagerModules,row.totalBytes,row.eagerBytes].every(Number.isSafeInteger)) fail('graph');
  }
  return {entry:report.entry, directories:[...directories.values()].sort((a,b) => a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0)};
}

try {
  if (process.argv.length !== 3) fail('argv');
  let input;
  try { input = readFileSync(process.argv[2] === '-' ? 0 : process.argv[2], 'utf8'); } catch { fail('file'); }
  let report;
  try { report = JSON.parse(input); } catch { fail('json'); }
  process.stdout.write(JSON.stringify(rollup(report)) + '\n');
} catch (error) {
  const category = ['argv','file','json','shape','graph'].includes(error.message) ? error.message : 'graph';
  process.stderr.write(category + '\n');
  process.exitCode = 1;
}
