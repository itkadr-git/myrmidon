import { readFileSync } from 'node:fs';

const fail = category => { throw category; };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const name = value => text(value) && value.length > 0;
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const quote = value => `"${value.replace(/[\\"\n\r\t]/g, c => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\n', '\t': '\\t' })[c])}"`;

function render(report) {
  if (!object(report) || !name(report.entry) || !Array.isArray(report.modules) || report.modules.length === 0 || !Array.isArray(report.edges)) fail('shape');
  const modules = new Map();
  for (const m of report.modules) {
    if (!object(m) || !name(m.path) || !Number.isSafeInteger(m.bytes) || m.bytes < 0 || typeof m.eager !== 'boolean' || modules.has(m.path)) fail('shape');
    modules.set(m.path, m);
  }
  for (const e of report.edges) {
    if (!object(e) || !name(e.from) || !text(e.specifier) || !['eager', 'lazy'].includes(e.kind) || !(e.to === null || name(e.to))) fail('shape');
  }
  if (!modules.has(report.entry)) fail('graph');
  const seen = new Set(), adjacency = new Map();
  for (const e of report.edges) {
    const key = JSON.stringify([e.from, e.specifier, e.kind, e.to]);
    if (!modules.has(e.from) || (e.to !== null && !modules.has(e.to)) || seen.has(key)) fail('graph');
    seen.add(key);
    if (e.kind === 'eager' && e.to !== null) {
      if (!adjacency.has(e.from)) adjacency.set(e.from, []);
      adjacency.get(e.from).push(e.to);
    }
  }
  const eager = new Set(), pending = [report.entry];
  while (pending.length) {
    const path = pending.pop();
    if (eager.has(path)) continue;
    eager.add(path);
    pending.push(...(adjacency.get(path) || []));
  }
  for (const m of modules.values()) if (m.eager !== eager.has(m.path)) fail('graph');
  const sorted = [...modules.values()].sort((a, b) => cmp(a.path, b.path));
  const ids = new Map(sorted.map((m, i) => [m.path, `n${i}`]));
  const lines = ['digraph imports {'];
  for (const m of sorted) lines.push(`  ${ids.get(m.path)} [label=${quote(m.path)}, style=${m.eager ? 'solid' : 'dashed'}];`);
  const edges = report.edges.filter(e => e.to !== null).sort((a, b) => cmp(a.from, b.from) || cmp(a.specifier, b.specifier) || cmp(a.kind, b.kind) || cmp(a.to, b.to));
  for (const e of edges) lines.push(`  ${ids.get(e.from)} -> ${ids.get(e.to)} [label=${quote(e.specifier)}, style=${e.kind === 'eager' ? 'solid' : 'dashed'}];`);
  lines.push(`  // unresolved: ${report.edges.length - edges.length}`, '}');
  return `${lines.join('\n')}\n`;
}

try {
  if (process.argv.length !== 2) fail('argv');
  let report;
  try { report = JSON.parse(readFileSync(0, 'utf8')); } catch { fail('json'); }
  process.stdout.write(render(report));
} catch (error) {
  process.stderr.write(`${['argv', 'json', 'shape', 'graph'].includes(error) ? error : 'shape'}\n`);
  process.exitCode = 1;
}
