import { readFileSync } from 'node:fs';

// The result is a static byte estimate, not a timing measurement.
const fail = category => { throw category; };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;

function evaluate(report, from, specifier) {
  if (!object(report) || typeof report.entry !== 'string' || !Array.isArray(report.modules) || !Array.isArray(report.edges)) fail('shape');
  const modules = new Map();
  for (const mod of report.modules) {
    if (!object(mod) || !nonempty(mod.path) || !Number.isSafeInteger(mod.bytes) || mod.bytes < 0 || typeof mod.eager !== 'boolean') fail('shape');
    if (modules.has(mod.path)) fail('graph');
    modules.set(mod.path, mod);
  }
  if (!modules.has(report.entry)) fail('graph');
  const seen = new Set(), adjacency = new Map();
  for (const edge of report.edges) {
    if (!object(edge) || !nonempty(edge.from) || !nonempty(edge.specifier) || !['eager', 'lazy'].includes(edge.kind) || !(edge.to === null || typeof edge.to === 'string')) fail('shape');
    if (!modules.has(edge.from) || (edge.to !== null && !modules.has(edge.to))) fail('graph');
    const key = JSON.stringify([edge.from, edge.specifier, edge.kind, edge.to]);
    if (seen.has(key)) fail('graph');
    seen.add(key);
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge);
  }
  function closure(excluded) {
    const visited = new Set(), stack = [report.entry];
    while (stack.length) {
      const path = stack.pop();
      if (visited.has(path)) continue;
      visited.add(path);
      for (const edge of adjacency.get(path) || []) if (edge !== excluded && edge.kind === 'eager' && edge.to !== null) stack.push(edge.to);
    }
    return visited;
  }
  const before = closure(null);
  for (const mod of modules.values()) if (mod.eager !== before.has(mod.path)) fail('graph');
  const matches = report.edges.filter(edge => edge.from === from && edge.specifier === specifier && edge.kind === 'eager' && edge.to !== null);
  if (matches.length !== 1) fail('selection');
  const selected = matches[0], after = closure(selected);
  const totals = paths => ({ modules: paths.size, bytes: [...paths].reduce((sum, path) => sum + modules.get(path).bytes, 0) });
  const beforeTotals = totals(before), afterTotals = totals(after);
  if (!Number.isSafeInteger(beforeTotals.bytes) || !Number.isSafeInteger(afterTotals.bytes)) fail('graph');
  return { entry: report.entry, selected: { from: selected.from, specifier: selected.specifier, to: selected.to }, before: beforeTotals, after: afterTotals, removedPaths: [...before].filter(path => !after.has(path)).sort(), savedBytes: beforeTotals.bytes - afterTotals.bytes };
}

try {
  if (process.argv.length !== 5 || !process.argv.slice(2).every(nonempty)) fail('argv');
  let text, report;
  try { text = readFileSync(process.argv[2], 'utf8'); } catch { fail('read'); }
  try { report = JSON.parse(text); } catch { fail('json'); }
  process.stdout.write(`${JSON.stringify(evaluate(report, process.argv[3], process.argv[4]))}\n`);
} catch (error) {
  const category = ['argv', 'read', 'json', 'shape', 'graph', 'selection'].includes(error) ? error : 'graph';
  process.stderr.write(`error: ${category}\n`);
  process.exitCode = 1;
}
