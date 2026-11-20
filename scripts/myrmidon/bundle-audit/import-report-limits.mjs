import { readFileSync } from 'node:fs';

const safe = value => Number.isSafeInteger(value) && value >= 0;
function argumentsFrom(argv) {
  const flags = new Map();
  if (argv.length !== 4) throw new Error('argv');
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, text] = argv.slice(i, i + 2);
    if (!['--max-eager-bytes', '--max-eager-modules'].includes(flag) || flags.has(flag) || !/^[0-9]+$/.test(text) || !safe(Number(text))) throw new Error('argv');
    flags.set(flag, Number(text));
  }
  if (flags.size !== 2) throw new Error('argv');
  return [flags.get('--max-eager-bytes'), flags.get('--max-eager-modules')];
}
function totals(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.modules) || !safe(report.counts?.eagerModules) || !safe(report.bytes?.eager)) throw new Error('report');
  let eagerBytes = 0, eagerModules = 0;
  const paths = new Set();
  for (const item of report.modules) {
    if (!item || typeof item.path !== 'string' || !item.path || paths.has(item.path) || !safe(item.bytes) || typeof item.eager !== 'boolean') throw new Error('report');
    paths.add(item.path);
    if (item.eager) { eagerBytes += item.bytes; eagerModules++; }
    if (!safe(eagerBytes)) throw new Error('report');
  }
  if (eagerBytes !== report.bytes.eager || eagerModules !== report.counts.eagerModules) throw new Error('report');
  return [eagerBytes, eagerModules];
}
try {
  const [maxEagerBytes, maxEagerModules] = argumentsFrom(process.argv.slice(2));
  let report;
  try { report = JSON.parse(readFileSync(0, 'utf8')); } catch { throw new Error('report'); }
  const [eagerBytes, eagerModules] = totals(report);
  const violations = [];
  if (eagerBytes > maxEagerBytes) violations.push('eagerBytes');
  if (eagerModules > maxEagerModules) violations.push('eagerModules');
  const ok = violations.length === 0;
  process.stdout.write(`${JSON.stringify({ ok, eagerBytes, eagerModules, maxEagerBytes, maxEagerModules, violations })}\n`);
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  process.stderr.write(`${error.message === 'argv' ? 'argv' : 'report'} error\n`);
  process.exitCode = 2;
}
