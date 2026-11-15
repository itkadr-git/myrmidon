#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

function address(value) {
  const family = typeof value === 'string' ? isIP(value) : 0;
  if (!family) throw new Error(`Invalid IP address: ${value}`);
  return family === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
}

function prefix(value) {
  if (value === 'default') return value;
  if (typeof value !== 'string') throw new Error('Route prefix must be a string');
  const parts = value.split('/');
  if (parts.length > 2) throw new Error(`Invalid prefix: ${value}`);
  const ip = address(parts[0]);
  const max = isIP(ip) === 6 ? 128 : 32;
  const bits = parts.length === 1 ? max : Number(parts[1]);
  if ((parts.length === 2 && !/^\d+$/.test(parts[1])) || !Number.isInteger(bits) || bits < 0 || bits > max) throw new Error(`Invalid prefix: ${value}`);
  return `${ip}/${bits}`;
}

function table(value) {
  if (value === undefined || value === 'main' || value === 254 || value === '254') return 'main';
  if ((typeof value === 'number' && Number.isInteger(value) && value >= 0) || (typeof value === 'string' && value.length && /^[a-zA-Z0-9_-]+$/.test(value))) return String(value);
  throw new Error('Invalid route table');
}

function normalize(route, expected) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) throw new Error('Route must be an object');
  if (expected && (!Object.hasOwn(route, 'prefix') || !Object.hasOwn(route, 'table') || !Object.hasOwn(route, 'via') || !Object.hasOwn(route, 'dev'))) throw new Error('Expected routes require prefix, table, via and dev');
  if (!expected && (route.multipath !== undefined || (route.type !== undefined && route.type !== 'unicast') || route.nexthops !== undefined || route.nhid !== undefined)) throw new Error('Unsupported route type or multipath');
  const via = expected ? route.via : route.gateway;
  if (via !== undefined && via !== null && typeof via !== 'string') throw new Error('Invalid gateway');
  if (typeof route.dev !== 'string' || !route.dev.trim()) throw new Error('Route requires dev');
  return { prefix: prefix(expected ? route.prefix : (route.dst === undefined ? 'default' : route.dst)), table: table(route.table), via: via == null ? null : address(via), dev: route.dev };
}

export function compareRoutes(expected, snapshot) {
  if (!Array.isArray(expected) || expected.length === 0 || !Array.isArray(snapshot)) throw new Error('Expected a non-empty expected route array and a snapshot array');
  const actual = snapshot.map(route => normalize(route, false));
  return expected.map(route => {
    const wanted = normalize(route, true);
    const candidates = actual.filter(item => item.prefix === wanted.prefix);
    const matches = item => item.table === wanted.table && item.via === wanted.via && item.dev === wanted.dev;
    const status = candidates.length === 0 ? 'missing' : candidates.every(matches) ? 'ok' : 'conflicting';
    return { expected: wanted, status, observed: candidates };
  });
}

function main(args) {
  if (args.length !== 2) throw new Error('Usage: node route-matrix.mjs EXPECTED.json ROUTES.json');
  const expected = JSON.parse(readFileSync(args[0], 'utf8'));
  const snapshot = JSON.parse(readFileSync(args[1], 'utf8'));
  const results = compareRoutes(expected, snapshot);
  console.log(JSON.stringify({ results }, null, 2));
  return results.every(result => result.status === 'ok') ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
