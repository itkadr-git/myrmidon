import { readFileSync } from 'node:fs';

const fail = category => { throw new Error(category); };
const safe = value => Number.isSafeInteger(value) && value >= 0;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const compareEdge = (a, b) => compare(a.from, b.from) || compare(a.specifier, b.specifier) || compare(a.kind, b.kind) || (a.to === null ? (b.to === null ? 0 : -1) : b.to === null ? 1 : compare(a.to, b.to));

function readReport(file) {
  let report;
  try { report = JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8')); } catch { fail('invalid json or file'); }
  if (!report || typeof report !== 'object' || Array.isArray(report) || typeof report.entry !== 'string' || !report.entry || !Array.isArray(report.modules) || report.modules.length === 0 || !Array.isArray(report.edges)) fail('invalid report');

  const modules = new Map();
  for (const module of report.modules) {
    if (!module || typeof module !== 'object' || typeof module.path !== 'string' || !module.path || !safe(module.bytes) || typeof module.eager !== 'boolean') fail('invalid module');
    if (modules.has(module.path)) fail('duplicate module');
    modules.set(module.path, { path: module.path, bytes: module.bytes, eager: module.eager });
  }
  if (!modules.has(report.entry)) fail('dangling entry');

  const edges = new Map();
  const adjacency = new Map();
  for (const edge of report.edges) {
    if (!edge || typeof edge !== 'object' || typeof edge.from !== 'string' || !edge.from || typeof edge.specifier !== 'string' || typeof edge.kind !== 'string' || !['eager', 'lazy'].includes(edge.kind) || !(typeof edge.to === 'string' || edge.to === null) || (typeof edge.to === 'string' && !edge.to)) fail('invalid edge');
    if (!modules.has(edge.from) || (edge.to !== null && !modules.has(edge.to))) fail('dangling edge');
    const normalized = { from: edge.from, specifier: edge.specifier, kind: edge.kind, to: edge.to };
    const key = JSON.stringify([normalized.from, normalized.specifier, normalized.kind, normalized.to]);
    if (edges.has(key)) fail('duplicate edge');
    edges.set(key, normalized);
    if (edge.kind === 'eager' && edge.to !== null) {
      if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
      adjacency.get(edge.from).push(edge.to);
    }
  }

  const eager = new Set([report.entry]);
  const pending = [report.entry];
  while (pending.length) {
    const from = pending.pop();
    for (const to of adjacency.get(from) || []) {
      if (!eager.has(to)) {
        eager.add(to);
        pending.push(to);
      }
    }
  }
  for (const [path, module] of modules) if (module.eager !== eager.has(path)) fail('invalid eager closure');
  return { entry: report.entry, edges };
}

try {
  if (process.argv.length !== 4 || (process.argv[2] === '-' && process.argv[3] === '-')) fail('invalid arguments');
  const base = readReport(process.argv[2]);
  const current = readReport(process.argv[3]);
  if (base.entry !== current.entry) fail('entry mismatch');
  const added = [...current.edges].filter(([key]) => !base.edges.has(key)).map(([, value]) => value).sort(compareEdge);
  const removed = [...base.edges].filter(([key]) => !current.edges.has(key)).map(([, value]) => value).sort(compareEdge);
  process.stdout.write(`${JSON.stringify({ entry: base.entry, added, removed }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
