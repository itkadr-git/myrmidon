import { readFileSync } from 'node:fs';

const fail = category => { throw category; };
const nonempty = value => typeof value === 'string' && value.length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function analyze(report, target) {
  if (!object(report) || !nonempty(report.entry) || !Array.isArray(report.modules) || !Array.isArray(report.edges)) fail('shape');
  const modules = new Map(), next = new Map(), predecessors = new Map();
  let total = 0;
  for (const mod of report.modules) {
    if (!object(mod) || !nonempty(mod.path) || !Number.isSafeInteger(mod.bytes) || mod.bytes < 0 || typeof mod.eager !== 'boolean' || modules.has(mod.path)) fail('shape');
    total += mod.bytes;
    if (!Number.isSafeInteger(total)) fail('shape');
    modules.set(mod.path, mod); next.set(mod.path, []); predecessors.set(mod.path, []);
  }
  if (!modules.has(report.entry)) fail('graph');
  const seen = new Set();
  for (const edge of report.edges) {
    if (!object(edge) || !nonempty(edge.from) || !nonempty(edge.specifier) || !['eager','lazy'].includes(edge.kind) || !(edge.to === null || nonempty(edge.to))) fail('shape');
    if (!modules.has(edge.from) || (edge.to !== null && !modules.has(edge.to))) fail('graph');
    const key = JSON.stringify([edge.from,edge.specifier,edge.kind,edge.to]);
    if (seen.has(key)) fail('graph');
    seen.add(key);
    if (edge.kind === 'eager' && edge.to !== null) { next.get(edge.from).push(edge.to); predecessors.get(edge.to).push(edge.from); }
  }
  const reachable = new Set(), pending = [report.entry];
  while (pending.length) {
    const node = pending.pop();
    if (reachable.has(node)) continue;
    reachable.add(node); pending.push(...next.get(node));
  }
  for (const [name, mod] of modules) if (mod.eager !== reachable.has(name)) fail('graph');
  if (!reachable.has(target)) fail('graph');
  const dom = new Map([...reachable].map(name => [name, name === report.entry ? new Set([name]) : new Set(reachable)]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of reachable) {
      if (name === report.entry) continue;
      const preds = predecessors.get(name).filter(p => reachable.has(p));
      const intersection = new Set(dom.get(preds[0]));
      for (const pred of preds.slice(1)) for (const candidate of intersection) if (!dom.get(pred).has(candidate)) intersection.delete(candidate);
      intersection.add(name);
      const previous = dom.get(name);
      if (intersection.size !== previous.size || [...intersection].some(x => !previous.has(x))) { dom.set(name, intersection); changed = true; }
    }
  }
  return { entry: report.entry, target, dominators: [...dom.get(target)].sort() };
}
try {
  if (process.argv.length !== 4 || !nonempty(process.argv[3])) fail('argv');
  let data;
  try { data = readFileSync(process.argv[2] === '-' ? 0 : process.argv[2], 'utf8'); } catch { fail('read'); }
  let report;
  try { report = JSON.parse(data); } catch { fail('json'); }
  process.stdout.write(JSON.stringify(analyze(report, process.argv[3])) + '\n');
} catch (error) {
  process.stderr.write(`${typeof error === 'string' ? error : 'graph'}\n`);
  process.exitCode = 1;
}
