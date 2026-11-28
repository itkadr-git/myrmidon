#!/usr/bin/env node
import { readFileSync } from 'node:fs';

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} must contain exactly: ${keys.join(', ')}`);
  }
}

function token(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function list(value, pattern, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  return value.map((item) => token(item, pattern, label)).join(', ');
}

function render(input) {
  object(input, ['name', 'local', 'remote', 'proposals', 'secretFile'], 'input');
  const name = token(input.name, /^[A-Za-z0-9_-]+$/, 'name');
  const sides = ['local', 'remote'].map((key) => {
    const side = input[key];
    object(side, ['endpoint', 'identity', 'trafficSelectors'], key);
    return {
      endpoint: token(side.endpoint, /^[A-Za-z0-9._:%-]+$/, `${key}.endpoint`),
      identity: token(side.identity, /^[@A-Za-z0-9._:%-]+$/, `${key}.identity`),
      selectors: list(side.trafficSelectors, /^[A-Za-z0-9.:/%_-]+$/, `${key}.trafficSelectors`),
    };
  });
  const proposals = list(input.proposals, /^[A-Za-z0-9_-]+$/, 'proposals');
  const secretFile = token(input.secretFile, /^\/[A-Za-z0-9._/-]+$/, 'secretFile');
  const [local, remote] = sides;
  return `connections {
  ${name} {
    version = 2
    local_addrs = ${local.endpoint}
    remote_addrs = ${remote.endpoint}
    proposals = ${proposals}
    local {
      auth = psk
      id = ${local.identity}
    }
    remote {
      auth = psk
      id = ${remote.identity}
    }
    children {
      ${name} {
        local_ts = ${local.selectors}
        remote_ts = ${remote.selectors}
      }
    }
  }
}
include ${secretFile}
`;
}

try {
  if (process.argv.length !== 2) throw new Error('usage: node render-swanctl.mjs < input.json');
  const output = render(JSON.parse(readFileSync(0, 'utf8')));
  process.stdout.write(output);
} catch (error) {
  process.stderr.write(`render-swanctl: ${error.message}\n`);
  process.exitCode = 1;
}
