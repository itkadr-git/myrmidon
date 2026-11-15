#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

const REDACTED = '[REDACTED]';
const secretKey = /(?:psk|password|passwd|token|secret|bearer|authorization|private.?key)/i;
const stateKeys = new Set(['state', 'sa_state']);
const counterKeys = new Set(['bytes_in', 'bytes_out', 'bytesin', 'bytesout', 'in_bytes', 'out_bytes', 'byte_counter', 'byte_counters']);
const routeKeys = new Set(['route', 'prefix', 'route_prefix', 'route_prefixes']);

function safeScalar(key, value) {
  const name = key.toLowerCase();
  if (stateKeys.has(name) && typeof value === 'string' && /^(?:established|installed|connecting|down|up|deleted|rekeying|connecting|new|routed)$/i.test(value)) return value;
  if (counterKeys.has(name) && (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 || typeof value === 'string' && /^\d+$/.test(value))) return value;
  if (routeKeys.has(name) && typeof value === 'string') {
    const match = /^([^/]+)\/(\d{1,3})$/.exec(value);
    if (match) {
      const version = isIP(match[1]);
      if (version && Number(match[2]) <= (version === 4 ? 32 : 128)) return value;
    }
  }
  throw new Error('unsupported field');
}

function redactJson(value, key = '') {
  if (secretKey.test(key)) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactJson(item, key));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactJson(item, name)]));
  }
  return safeScalar(key, value);
}

function redactText(input) {
  const lines = input.split(/\r?\n/);
  const output = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line && i === lines.length - 1) continue;
    const match = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*([:=])\s*(.*?)\s*$/.exec(line);
    if (!match) throw new Error('unsupported text');
    const [, key, separator, value] = match;
    if (secretKey.test(key)) {
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
        const start = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----/.exec(value);
        const end = `-----END ${start[1]}-----`;
        if (!value.includes(end)) {
          while (++i < lines.length && !lines[i].includes(end)) {}
          if (i === lines.length) throw new Error('incomplete key');
        }
      }
      output.push(`${key}${separator} ${REDACTED}`);
    } else {
      output.push(`${key}${separator} ${safeScalar(key, value)}`);
    }
  }
  return output.join('\n') + '\n';
}

try {
  if (process.argv.length !== 4 || process.argv[2] !== '--format' || !['json', 'text'].includes(process.argv[3])) throw new Error('unsupported format');
  const input = readFileSync(0, 'utf8');
  const output = process.argv[3] === 'json' ? JSON.stringify(redactJson(JSON.parse(input)), null, 2) + '\n' : redactText(input);
  process.stdout.write(output);
} catch {
  process.stderr.write('Unable to redact input: unsupported or invalid format.\n');
  process.exitCode = 1;
}
