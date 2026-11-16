#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const fail = category => { throw category; };
const string = x => typeof x === 'string' && x.length > 0;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const edgeCmp = (a, b) => cmp(a.from,b.from) || cmp(a.specifier,b.specifier) || cmp(a.kind,b.kind) || (a.to === b.to ? 0 : a.to === null ? -1 : b.to === null ? 1 : cmp(a.to,b.to));
function closure(root, adjacency, all) {
  const seen = new Set(), pending = [root];
  while (pending.length) {
    const path = pending.pop(); if (seen.has(path)) continue; seen.add(path);
    for (const edge of adjacency.get(path) || []) if ((all || edge.kind === 'eager') && edge.to !== null) pending.push(edge.to);
  }
  return seen;
}
function project(report, root, mode) {
  if (!object(report) || !string(report.entry) || !Array.isArray(report.modules) || !Array.isArray(report.edges)) fail('shape');
  const modules = new Map(), adjacency = new Map(), tuples = new Set();
  for (const m of report.modules) {
    if (!object(m) || !string(m.path) || !Number.isSafeInteger(m.bytes) || m.bytes < 0 || typeof m.eager !== 'boolean') fail('shape');
    if (modules.has(m.path)) fail('graph');
    modules.set(m.path,m);
  }
  if (!modules.has(report.entry) || !modules.has(root)) fail('graph');
  for (const e of report.edges) {
    if (!object(e) || !string(e.from) || !string(e.specifier) || !['eager','lazy'].includes(e.kind) || !(e.to === null || string(e.to))) fail('shape');
    const tuple = JSON.stringify([e.from,e.specifier,e.kind,e.to]);
    if (tuples.has(tuple) || !modules.has(e.from) || (e.to !== null && !modules.has(e.to))) fail('graph');
    tuples.add(tuple); if (!adjacency.has(e.from)) adjacency.set(e.from,[]); adjacency.get(e.from).push(e);
  }
  const eager = closure(report.entry,adjacency,false);
  for (const m of modules.values()) if (m.eager !== eager.has(m.path)) fail('graph');
  const reached = closure(root,adjacency,mode === 'all');
  const edges = report.edges.filter(e => reached.has(e.from) && (mode === 'all' || e.kind === 'eager')).sort(edgeCmp);
  return {root,mode,modules:[...reached].sort(cmp).map(path => modules.get(path)),edges,unknown:edges.filter(e => e.to === null)};
}
try {
  const args = process.argv.slice(2);
  if (args.length !== 3 || !string(args[0]) || !string(args[1]) || !['eager','all'].includes(args[2])) fail('argv');
  let input; try { input = readFileSync(args[0] === '-' ? 0 : args[0], 'utf8'); } catch { fail('read'); }
  let report; try { report = JSON.parse(input); } catch { fail('json'); }
  process.stdout.write(JSON.stringify(project(report,args[1],args[2])) + '\n');
} catch (error) {
  console.error(`${['argv','read','json','shape','graph'].includes(error) ? error : 'shape'} error`);
  process.exitCode = 1;
}
