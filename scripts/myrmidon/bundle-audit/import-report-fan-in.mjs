import { readFileSync } from 'node:fs';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const invalid = () => { throw new Error('invalid'); };

function report(input) {
  if (!object(input) || !text(input.entry) || !Array.isArray(input.modules) || !Array.isArray(input.edges)) invalid();
  const modules = new Map();
  for (const item of input.modules) {
    if (!object(item) || !text(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || typeof item.eager !== 'boolean' || modules.has(item.path)) invalid();
    modules.set(item.path, item);
  }
  if (!modules.has(input.entry)) invalid();
  const outgoing = new Map();
  const tuples = new Set();
  for (const edge of input.edges) {
    if (!object(edge) || !text(edge.from) || !text(edge.specifier) || !['eager', 'lazy'].includes(edge.kind) || !(edge.to === null || text(edge.to)) || !modules.has(edge.from) || (edge.to !== null && !modules.has(edge.to))) invalid();
    const key = JSON.stringify([edge.from, edge.specifier, edge.kind, edge.to]);
    if (tuples.has(key)) invalid();
    tuples.add(key);
    if (edge.kind === 'eager' && edge.to !== null) {
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
      outgoing.get(edge.from).push(edge.to);
    }
  }
  const reachable = new Set();
  const pending = [input.entry];
  while (pending.length) {
    const current = pending.pop();
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const target of outgoing.get(current) || []) pending.push(target);
  }
  for (const [path, item] of modules) if (item.eager !== reachable.has(path)) invalid();
  const importers = new Map([...reachable].map(path => [path, new Set()]));
  for (const from of reachable) {
    for (const to of outgoing.get(from) || []) if (to !== from) importers.get(to).add(from);
  }
  const result = [...reachable].map(path => {
    const names = [...importers.get(path)].sort(compare);
    return { path, bytes: modules.get(path).bytes, importerCount: names.length, importers: names };
  });
  result.sort((a, b) => b.importerCount - a.importerCount || b.bytes - a.bytes || compare(a.path, b.path));
  return { entry: input.entry, modules: result };
}

try {
  if (process.argv.length !== 3) invalid();
  const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(`${JSON.stringify(report(input))}\n`);
} catch {
  process.stderr.write('fan-in report: invalid input\n');
  process.exitCode = 1;
}
