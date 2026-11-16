#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const fail = category => { process.stderr.write(`FAIL: ${category}\n`); process.exit(1); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = x => typeof x === 'string' && x.length > 0;
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function validate(report) {
  if (!object(report) || typeof report.entry !== 'string' || !Array.isArray(report.modules) || !Array.isArray(report.edges)) fail('shape');
  const paths = new Set();
  for (const m of report.modules) {
    if (!object(m) || !text(m.path) || !Number.isSafeInteger(m.bytes) || m.bytes < 0 || typeof m.eager !== 'boolean') fail('shape');
    if (paths.has(m.path)) fail('duplicate');
    paths.add(m.path);
  }
  if (!paths.has(report.entry)) fail('reference');
  const keys = new Set();
  for (const e of report.edges) {
    if (!object(e) || !text(e.from) || !text(e.specifier) || !['eager', 'lazy'].includes(e.kind) || !(e.to === null || text(e.to))) fail('shape');
    if (!paths.has(e.from) || (e.to !== null && !paths.has(e.to))) fail('reference');
    const key = JSON.stringify([e.from, e.specifier, e.kind, e.to]);
    if (keys.has(key)) fail('duplicate');
    keys.add(key);
  }
}

// Iterative Kosaraju traversal avoids exhausting the call stack on large reports.
function cycles(report, eagerOnly) {
  const forward = new Map(report.modules.map(m => [m.path, new Set()]));
  const reverse = new Map(report.modules.map(m => [m.path, new Set()]));
  for (const e of report.edges) {
    if (e.to === null || (eagerOnly && e.kind !== 'eager')) continue;
    forward.get(e.from).add(e.to); reverse.get(e.to).add(e.from);
  }
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
  const result = [];
  while (order.length) {
    const start = order.pop(); if (visited.has(start)) continue;
    const component = [], stack = [start]; visited.add(start);
    while (stack.length) {
      const node = stack.pop(); component.push(node);
      for (const next of reverse.get(node)) if (!visited.has(next)) { visited.add(next); stack.push(next); }
    }
    if (component.length > 1 || forward.get(start).has(start)) result.push(component.sort(cmp));
  }
  return result.sort((a, b) => cmp(a[0], b[0]));
}

if (process.argv.length !== 3) fail('arguments');
let input;
try { input = readFileSync(process.argv[2] === '-' ? 0 : process.argv[2], 'utf8'); } catch { fail('read'); }
let report;
try { report = JSON.parse(input); } catch { fail('json'); }
validate(report);
process.stdout.write(`${JSON.stringify({ entry: report.entry, eagerCycles: cycles(report, true), allCycles: cycles(report, false) })}\n`);
