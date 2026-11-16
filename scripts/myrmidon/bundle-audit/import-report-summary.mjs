#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const fail = () => { throw new Error('Invalid report'); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string';
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
// Encode Markdown punctuation as well as HTML syntax, so values remain plain text.
const escape = value => value.replace(/[&<>|`\[\]!*_\\()\u0000-\u001f\u007f-\u009f]/g, c => {
  if (c === '&') return '&amp;';
  if (c === '<') return '&lt;';
  if (c === '>') return '&gt;';
  return `&#${c.codePointAt(0)};`;
});

function format(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.modules) || !Array.isArray(report.edges) || !report.counts || !report.bytes) fail();
  const paths = new Set();
  for (const m of report.modules) {
    if (!m || !text(m.path) || !integer(m.bytes) || typeof m.eager !== 'boolean' || paths.has(m.path)) fail();
    paths.add(m.path);
  }
  for (const e of report.edges) {
    if (!e || !text(e.from) || !text(e.specifier) || !['eager', 'lazy'].includes(e.kind) || !(e.to === null || text(e.to)) || !paths.has(e.from) || (e.to !== null && !paths.has(e.to))) fail();
  }
  const eager = report.modules.filter(m => m.eager);
  const total = report.modules.reduce((n, m) => n + m.bytes, 0);
  const eagerBytes = eager.reduce((n, m) => n + m.bytes, 0);
  if (![total, eagerBytes, report.counts.modules, report.counts.eagerModules, report.counts.edges, report.bytes.total, report.bytes.eager].every(integer) || report.counts.modules !== report.modules.length || report.counts.eagerModules !== eager.length || report.counts.edges !== report.edges.length || report.bytes.total !== total || report.bytes.eager !== eagerBytes) fail();
  const unknown = report.edges.filter(e => e.to === null).sort((a, b) => cmp(a.specifier, b.specifier) || cmp(a.kind, b.kind) || cmp(a.from, b.from));
  eager.sort((a, b) => b.bytes - a.bytes || cmp(a.path, b.path));
  const lines = ['## Import report summary', '', 'Static source bytes do not establish a performance win or verify production.', '', '| Metric | Value |', '| --- | ---: |', `| modules | ${report.modules.length} |`, `| eagerModules | ${eager.length} |`, `| totalBytes | ${total} |`, `| eagerBytes | ${eagerBytes} |`, '', '### Top eager modules', '', '| Path | Bytes |', '| --- | ---: |'];
  for (const m of eager.slice(0, 10)) lines.push(`| ${escape(m.path)} | ${m.bytes} |`);
  lines.push('', '### Unresolved dependencies', '', '| Specifier | Kind | From |', '| --- | --- | --- |');
  for (const e of unknown.slice(0, 50)) lines.push(`| ${escape(e.specifier)} | ${escape(e.kind)} | ${escape(e.from)} |`);
  lines.push('', `Omitted: ${Math.max(0, unknown.length - 50)}`, '');
  return lines.join('\n');
}

try {
  if (process.argv.length !== 2) throw new Error('Invalid arguments');
  let report;
  try { report = JSON.parse(readFileSync(0, 'utf8')); } catch { throw new Error('Invalid JSON'); }
  process.stdout.write(format(report));
} catch (error) {
  console.error(`Error: ${['Invalid arguments', 'Invalid JSON', 'Invalid report'].includes(error.message) ? error.message : 'Invalid report'}`);
  process.exitCode = 1;
}
