#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

function address(value) {
  if (typeof value !== 'string' || value.includes('%')) return null;
  const family = isIP(value);
  if (!family) return null;
  if (family === 4) return { family, bits: 32, value: value.split('.').reduce((n, octet) => (n << 8n) | BigInt(octet), 0n) };
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split('::');
  const before = left ? left.split(':') : [];
  const after = right ? right.split(':') : [];
  const groups = canonical.includes('::') ? [...before, ...Array(8 - before.length - after.length).fill('0'), ...after] : before;
  return { family, bits: 128, value: groups.reduce((n, group) => (n << 16n) | BigInt(`0x${group}`), 0n) };
}

function cidr(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('/');
  if (parts.length !== 2 || !/^(0|[1-9]\d*)$/.test(parts[1])) return null;
  const ip = address(parts[0]);
  const prefix = Number(parts[1]);
  if (!ip || prefix > ip.bits) return null;
  const shift = BigInt(ip.bits - prefix);
  return { ...ip, prefix, network: (ip.value >> shift) << shift };
}

function overlap(a, b) {
  if (a.family !== b.family) return false;
  const shift = BigInt(a.bits - Math.min(a.prefix, b.prefix));
  return (a.network >> shift) === (b.network >> shift);
}

function validate(manifest) {
  const errors = [];
  const error = (path, message) => errors.push({ path, message });
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const fields = (value, allowed, path) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) error(`${path}.${key}`, 'Unknown field; plaintext secrets are forbidden');
  };
  if (!object(manifest)) { error('$', 'Expected an object'); return errors; }
  fields(manifest, ['sides'], '$');
  if (!Array.isArray(manifest.sides) || manifest.sides.length !== 2) {
    error('$.sides', 'Expected exactly two sides');
    return errors;
  }
  const endpoints = [];
  for (const [i, side] of manifest.sides.entries()) {
    const path = `$.sides[${i}]`;
    if (!object(side)) { error(path, 'Expected an object'); continue; }
    fields(side, ['endpoint', 'localCidr', 'remoteCidr', 'proposal', 'id', 'secretFile'], path);
    for (const key of ['proposal', 'id', 'secretFile']) {
      if (typeof side[key] !== 'string' || !side[key].trim()) error(`${path}.${key}`, 'Expected a non-empty string');
    }
    const endpoint = address(side.endpoint);
    if (!endpoint) error(`${path}.endpoint`, 'Expected an IPv4 or IPv6 address');
    endpoints.push(endpoint);
    const local = cidr(side.localCidr);
    const remote = cidr(side.remoteCidr);
    if (!local) error(`${path}.localCidr`, 'Expected a valid IPv4 or IPv6 CIDR');
    if (!remote) error(`${path}.remoteCidr`, 'Expected a valid IPv4 or IPv6 CIDR');
    if (local && remote && overlap(local, remote)) error(path, 'Local and remote networks overlap');
  }
  if (endpoints.length === 2 && endpoints[0] && endpoints[1] && endpoints[0].family === endpoints[1].family && endpoints[0].value === endpoints[1].value) error('$.sides', 'Endpoints must differ');
  return errors;
}

function output(status, errors, code) {
  console.log(JSON.stringify({ status, errors }));
  process.exitCode = code;
}

if (process.argv.length !== 3) {
  output('ERROR', [{ path: '$', message: 'Usage: node config-check.mjs <manifest.json>' }], 2);
} else {
  let manifest;
  try { manifest = JSON.parse(readFileSync(process.argv[2], 'utf8')); }
  catch { output('ERROR', [{ path: '$', message: 'Cannot read or parse manifest JSON' }], 2); }
  if (process.exitCode !== 2) {
    const errors = validate(manifest);
    output(errors.length ? 'FAIL' : 'PASS', errors, errors.length ? 1 : 0);
  }
}
