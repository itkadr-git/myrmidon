import { readFileSync } from 'node:fs';

const fail = category => { throw new Error(category); };
const safe = n => Number.isSafeInteger(n) && n >= 0;
const cmp = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

function readReport(file) {
  let report;
  try { report = JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8')); } catch { fail('invalid json or file'); }
  if (!report || typeof report.entry !== 'string' || !Array.isArray(report.modules)) fail('invalid report');
  const modules = new Map();
  let total = 0, eager = 0, eagerModules = 0;
  for (const module of report.modules) {
    if (!module || typeof module.path !== 'string' || !safe(module.bytes) || typeof module.eager !== 'boolean') fail('invalid module');
    if (modules.has(module.path)) fail('duplicate module');
    modules.set(module.path, module);
    total += module.bytes;
    if (module.eager) { eager += module.bytes; eagerModules++; }
    if (!safe(total) || !safe(eager)) fail('invalid totals');
  }
  if (!report.counts || !report.bytes || report.counts.modules !== modules.size || report.counts.eagerModules !== eagerModules || report.bytes.total !== total || report.bytes.eager !== eager) fail('invalid totals');
  return { entry: report.entry, modules, totals: { modules: modules.size, eagerModules, totalBytes: total, eagerBytes: eager } };
}

try {
  if (process.argv.length !== 4 || (process.argv[2] === '-' && process.argv[3] === '-')) fail('invalid arguments');
  const base = readReport(process.argv[2]), current = readReport(process.argv[3]);
  if (base.entry !== current.entry) fail('entry mismatch');
  const delta = Object.fromEntries(Object.keys(base.totals).map(key => [key, current.totals[key] - base.totals[key]]));
  if (Object.values(delta).some(value => !Number.isSafeInteger(value))) fail('invalid delta');
  const added = [], removed = [], changed = [];
  for (const [path, before] of base.modules) {
    const after = current.modules.get(path);
    if (!after) removed.push(before);
    else if (before.bytes !== after.bytes || before.eager !== after.eager) changed.push({ path, before: { bytes: before.bytes, eager: before.eager }, after: { bytes: after.bytes, eager: after.eager } });
  }
  for (const [path, module] of current.modules) if (!base.modules.has(path)) added.push(module);
  process.stdout.write(`${JSON.stringify({ entry: base.entry, delta, added: added.sort(cmp), removed: removed.sort(cmp), changed: changed.sort(cmp) }, null, 2)}\n`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
