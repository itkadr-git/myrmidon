import { readFileSync } from 'node:fs';

const fail = category => { throw category; };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function validate(report) {
  if (!object(report) || typeof report.entry !== 'string' || !Array.isArray(report.modules) || !Array.isArray(report.edges)) fail('report');
  const modules = new Set();
  for (const item of report.modules) {
    if (!object(item) || !nonempty(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || typeof item.eager !== 'boolean' || modules.has(item.path)) fail('report');
    modules.add(item.path);
  }
  if (!modules.has(report.entry)) fail('report');
  const edges = new Set(), adjacency = new Map();
  for (const item of report.edges) {
    if (!object(item) || !nonempty(item.from) || !nonempty(item.specifier) || !['eager', 'lazy'].includes(item.kind) || !(item.to === null || typeof item.to === 'string') || !modules.has(item.from) || (item.to !== null && !modules.has(item.to))) fail('report');
    const key = JSON.stringify([item.from, item.specifier, item.kind, item.to]);
    if (edges.has(key)) fail('report');
    edges.add(key);
    if (item.kind === 'eager' && item.to !== null) {
      if (!adjacency.has(item.from)) adjacency.set(item.from, []);
      adjacency.get(item.from).push(item.to);
    }
  }
  for (const destinations of adjacency.values()) destinations.sort(cmp);
  return { modules, adjacency };
}

function shortest(entry, target, adjacency) {
  const parents = new Map([[entry, null]]), queue = [entry];
  for (let i = 0; i < queue.length && !parents.has(target); i++) {
    for (const next of adjacency.get(queue[i]) ?? []) {
      if (!parents.has(next)) { parents.set(next, queue[i]); queue.push(next); }
    }
  }
  if (!parents.has(target)) return [];
  const path = [];
  for (let node = target; node !== null; node = parents.get(node)) path.push(node);
  return path.reverse();
}

try {
  if (process.argv.length !== 4) fail('arguments');
  let text;
  try { text = readFileSync(process.argv[2] === '-' ? 0 : process.argv[2], 'utf8'); } catch { fail('read'); }
  let report;
  try { report = JSON.parse(text); } catch { fail('json'); }
  const { modules, adjacency } = validate(report), target = process.argv[3];
  if (!modules.has(target)) fail('target');
  const path = shortest(report.entry, target, adjacency);
  process.stdout.write(JSON.stringify({ entry: report.entry, target, reachable: path.length > 0, path }) + '\n');
} catch (category) {
  process.stderr.write(`error: ${typeof category === 'string' ? category : 'report'}\n`);
  process.exitCode = 1;
}
