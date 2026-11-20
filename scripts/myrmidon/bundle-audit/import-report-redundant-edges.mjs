#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const fail = category => { throw category; };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function analyze(report) {
  if (!object(report) || !text(report.entry) || !Array.isArray(report.modules) || !Array.isArray(report.edges)) fail('shape');
  const paths = new Set(), keys = new Set(), outgoing = new Map();
  for (const mod of report.modules) {
    if (!object(mod) || !text(mod.path) || !Number.isSafeInteger(mod.bytes) || mod.bytes < 0 || typeof mod.eager !== 'boolean') fail('shape');
    if (paths.has(mod.path)) fail('graph');
    paths.add(mod.path);
  }
  if (!paths.has(report.entry)) fail('graph');
  const candidates = [];
  for (const edge of report.edges) {
    if (!object(edge) || !text(edge.from) || !text(edge.specifier) || !['eager', 'lazy'].includes(edge.kind) || !(edge.to === null || text(edge.to))) fail('shape');
    if (!paths.has(edge.from) || (edge.to !== null && !paths.has(edge.to))) fail('graph');
    const key = JSON.stringify([edge.from, edge.specifier, edge.kind, edge.to]);
    if (keys.has(key)) fail('graph');
    keys.add(key);
    if (edge.kind !== 'eager' || edge.to === null) continue;
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
    if (edge.from !== edge.to) candidates.push(edge);
  }
  for (const edges of outgoing.values()) edges.sort((a, b) => cmp(a.to, b.to) || cmp(a.specifier, b.specifier));
  candidates.sort((a, b) => cmp(a.from, b.from) || cmp(a.specifier, b.specifier) || cmp(a.to, b.to));
  const redundant = [];
  for (const candidate of candidates) {
    const previous = new Map([[candidate.from, null]]), queue = [candidate.from];
    for (let i = 0; i < queue.length && !previous.has(candidate.to); i++) {
      const from = queue[i];
      for (const edge of outgoing.get(from) ?? []) {
        if (edge === candidate || previous.has(edge.to)) continue;
        previous.set(edge.to, from); queue.push(edge.to);
      }
    }
    if (!previous.has(candidate.to)) continue;
    const alternativePath = [];
    for (let node = candidate.to; node !== null; node = previous.get(node)) alternativePath.push(node);
    alternativePath.reverse();
    redundant.push({ from: candidate.from, specifier: candidate.specifier, to: candidate.to, alternativePath });
  }
  return { entry: report.entry, redundant };
}

try {
  if (process.argv.length !== 2) fail('argv');
  let report;
  try { report = JSON.parse(readFileSync(0, 'utf8')); } catch { fail('json'); }
  process.stdout.write(`${JSON.stringify(analyze(report))}\n`);
} catch (error) {
  process.stderr.write(`${['argv', 'json', 'shape', 'graph'].includes(error) ? error : 'graph'}\n`);
  process.exitCode = 1;
}
