import { readFileSync } from 'node:fs';

const fail = category => { throw category; };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function inventory(report) {
  if (!object(report) || typeof report.entry !== 'string' || !Array.isArray(report.modules) || !Array.isArray(report.edges)) fail('shape');
  const modules = new Set();
  for (const module of report.modules) {
    if (!object(module) || !text(module.path) || !Number.isSafeInteger(module.bytes) || module.bytes < 0 || typeof module.eager !== 'boolean' || modules.has(module.path)) fail('shape');
    modules.add(module.path);
  }
  if (!modules.has(report.entry)) fail('graph');
  const seen = new Set(), external = new Map(), local = new Map();
  for (const edge of report.edges) {
    if (!object(edge) || !text(edge.from) || !text(edge.specifier) || !['eager', 'lazy'].includes(edge.kind) || !(edge.to === null || typeof edge.to === 'string')) fail('shape');
    const tuple = JSON.stringify([edge.from, edge.specifier, edge.kind, edge.to]);
    if (!modules.has(edge.from) || (edge.to !== null && !modules.has(edge.to)) || seen.has(tuple)) fail('graph');
    seen.add(tuple);
    if (edge.to !== null) continue;
    const groups = /^(?:[./]|[a-zA-Z]:)/.test(edge.specifier) ? local : external;
    if (!groups.has(edge.specifier)) groups.set(edge.specifier, { eager: new Set(), lazy: new Set() });
    groups.get(edge.specifier)[edge.kind].add(edge.from);
  }
  const rows = groups => [...groups].sort(([a], [b]) => cmp(a, b)).map(([specifier, kinds]) => ({ specifier, eagerImporters: [...kinds.eager].sort(cmp), lazyImporters: [...kinds.lazy].sort(cmp) }));
  return { entry: report.entry, externals: rows(external), unresolvedLocal: rows(local) };
}

try {
  if (process.argv.length !== 3) fail('argv');
  let source, report;
  try { source = readFileSync(process.argv[2] === '-' ? 0 : process.argv[2], 'utf8'); } catch { fail('read'); }
  try { report = JSON.parse(source); } catch { fail('json'); }
  process.stdout.write(JSON.stringify(inventory(report)) + '\n');
} catch (category) {
  process.stderr.write(`${['argv', 'read', 'json', 'shape', 'graph'].includes(category) ? category : 'shape'}\n`);
  process.exitCode = 1;
}
