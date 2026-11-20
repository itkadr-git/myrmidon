#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const fail = category => { throw category; };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' && value.length > 0;

function multiRoot(report, roots) {
  if (!object(report) || !name(report.entry) || !Array.isArray(report.modules) || !report.modules.length || !Array.isArray(report.edges)) fail('shape');
  const modules = new Map(), outgoing = new Map(), edges = new Set();
  for (const mod of report.modules) {
    if (!object(mod) || !name(mod.path) || !Number.isSafeInteger(mod.bytes) || mod.bytes < 0 || typeof mod.eager !== 'boolean') fail('shape');
    if (modules.has(mod.path)) fail('graph');
    modules.set(mod.path, mod.bytes);
  }
  if (!modules.has(report.entry) || roots.some(root => !modules.has(root))) fail('graph');
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
  const sum = paths => paths.reduce((total, path) => {
    const next = total + modules.get(path);
    if (!Number.isSafeInteger(next)) fail('graph');
    return next;
  }, 0);
  const counts = new Map();
  const perRoot = roots.map(root => {
    const reached = new Set([root]), queue = [root];
    for (let i = 0; i < queue.length; i++) {
      for (const to of outgoing.get(queue[i]) ?? []) {
        if (!reached.has(to)) { reached.add(to); queue.push(to); }
      }
    }
    const paths = [...reached].sort();
    for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
    return { root, paths, bytes: sum(paths) };
  });
  const paths = [...counts.keys()].sort();
  const sharedPaths = paths.filter(path => counts.get(path) >= 2);
  return { roots, paths, bytes: sum(paths), perRoot, sharedPaths, sharedBytes: sum(sharedPaths) };
}

try {
  const roots = process.argv.slice(2);
  if (!roots.length || roots.some(root => !name(root)) || new Set(roots).size !== roots.length) fail('argv');
  roots.sort();
  let report;
  try { report = JSON.parse(readFileSync(0, 'utf8')); } catch { fail('json'); }
  process.stdout.write(`${JSON.stringify(multiRoot(report, roots))}\n`);
} catch (error) {
  process.stderr.write(`${['argv', 'json', 'shape', 'graph'].includes(error) ? error : 'graph'}\n`);
  process.exitCode = 1;
}
