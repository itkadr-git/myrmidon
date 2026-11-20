#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const fail = category => {
  process.stderr.write(`FAIL: ${category}\n`);
  process.exit(1);
};
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSafeCount = value => Number.isSafeInteger(value) && value >= 0;

function validate(report) {
  if (!isObject(report)) fail('shape');
  if (typeof report.entry !== 'string' || !report.entry) fail('shape');
  for (const key of ['modules', 'edges', 'unknown', 'heaviestEager']) {
    if (!Array.isArray(report[key]) || (key === 'modules' && report[key].length === 0)) fail('shape');
  }
  if (!isObject(report.counts) || !isObject(report.bytes)) fail('shape');
  for (const key of ['modules', 'eagerModules', 'edges']) if (!isSafeCount(report.counts[key])) fail('shape');
  for (const key of ['total', 'eager']) if (!isSafeCount(report.bytes[key])) fail('shape');

  const paths = new Set();
  for (const module of report.modules) {
    if (!isObject(module) || typeof module.path !== 'string' || !module.path ||
        !isSafeCount(module.bytes) || typeof module.eager !== 'boolean') fail('shape');
    if (paths.has(module.path)) fail('duplicate');
    paths.add(module.path);
  }
  const edgeShape = edge => {
    if (!isObject(edge) || typeof edge.from !== 'string' || !edge.from ||
        typeof edge.specifier !== 'string' || typeof edge.kind !== 'string' ||
        !['eager', 'lazy'].includes(edge.kind) ||
        !(edge.to === null || (typeof edge.to === 'string' && edge.to))) fail('shape');
    if (!paths.has(edge.from) || (edge.to !== null && !paths.has(edge.to))) fail('reference');
    return JSON.stringify([edge.from, edge.specifier, edge.kind, edge.to]);
  };
  const edgeKeys = new Set();
  for (const edge of report.edges) {
    const key = edgeShape(edge);
    if (edgeKeys.has(key)) fail('duplicate');
    edgeKeys.add(key);
  }
  const unknownKeys = new Set();
  for (const edge of report.unknown) {
    const key = edgeShape(edge);
    if (unknownKeys.has(key)) fail('duplicate');
    unknownKeys.add(key);
    if (edge.to !== null) fail('inconsistent');
  }

  const entry = report.modules.find(module => module.path === report.entry);
  if (!entry || !entry.eager) fail('reference');
  const unknownEdges = report.edges.filter(edge => edge.to === null);
  if (unknownKeys.size !== unknownEdges.length || unknownEdges.some(edge => !unknownKeys.has(JSON.stringify([edge.from, edge.specifier, edge.kind, edge.to])))) fail('inconsistent');
  const eagerModules = report.modules.filter(module => module.eager);
  if (report.counts.modules !== report.modules.length ||
      report.counts.eagerModules !== eagerModules.length || report.counts.edges !== report.edges.length ||
      report.bytes.total !== report.modules.reduce((sum, module) => sum + module.bytes, 0) ||
      report.bytes.eager !== eagerModules.reduce((sum, module) => sum + module.bytes, 0)) fail('inconsistent');

  const expected = [...eagerModules].sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, 10);
  if (report.heaviestEager.length !== expected.length || report.heaviestEager.some((module, i) =>
    !isObject(module) || module.path !== expected[i].path || module.bytes !== expected[i].bytes || module.eager !== true)) fail('inconsistent');
}

if (process.argv.length !== 2) fail('arguments');
let report;
try { report = JSON.parse(readFileSync(0, 'utf8')); } catch { fail('json'); }
validate(report);
process.stdout.write('PASS: import report\n');
