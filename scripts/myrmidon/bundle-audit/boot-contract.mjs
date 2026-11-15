#!/usr/bin/env node
// Offline audit: stdin is data, never a shell command or an application to run.
import { readFileSync } from 'node:fs';

function optionsTokens(text) {
  const tokens = [];
  let token = '';
  let quoted = false;
  let active = false;
  for (const char of text) {
    if (char === '"') { quoted = !quoted; active = true; }
    else if (/\s/.test(char) && !quoted) {
      if (active) tokens.push(token);
      token = ''; active = false;
    } else { token += char; active = true; }
  }
  if (quoted || text.includes('\\')) throw new Error('NODE_OPTIONS has unsupported or unclosed quoting');
  if (active) tokens.push(token);
  return tokens;
}

function audit(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { errors: ['manifest must be an object'] };
  const { argv, env } = manifest;
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) {
    errors.push('argv must be an array of strings, not a shell command');
  } else {
    if (argv.length !== 2 || argv[0] !== 'node' || argv[1] !== 'server/dist/index.js') errors.push('argv must be exactly node server/dist/index.js');
    for (const arg of argv) {
      if (/(?:^|[/\\@])(?:tsx|ts-node)(?:$|[/\\@=.-])/i.test(arg) || /^--(?:experimental[-_])?loader(?:=|$)|^--import(?:=|$)/i.test(arg)) errors.push(`argv contains forbidden runtime option: ${arg}`);
    }
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    errors.push('env must be an object');
  } else {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== 'string') errors.push(`env.${key} must be a string`);
    }
    for (const name of ['VERSION', 'COMMIT']) {
      const value = env[`MYRMIDON_BUILD_${name}`] ?? env[`PAPERCLIP_BUILD_${name}`];
      if (typeof value !== 'string' || !value.trim() || /^(unknown|null|undefined)$/i.test(value.trim())) errors.push(`missing or unknown build ${name.toLowerCase()} stamp`);
    }
    if (env.NODE_OPTIONS !== undefined && typeof env.NODE_OPTIONS === 'string') {
      try {
        for (const token of optionsTokens(env.NODE_OPTIONS)) {
          if (/^--(?:experimental[-_])?loader(?:=|$)|^--import(?:=|$)/i.test(token) || /(?:^|[/\\@])(?:tsx|ts-node)(?:$|[/\\@=.-])/i.test(token)) errors.push(`NODE_OPTIONS contains forbidden runtime option: ${token}`);
        }
      } catch (error) { errors.push(error.message); }
    }
  }
  return { errors, nodeOptions: env && typeof env.NODE_OPTIONS === 'string' ? env.NODE_OPTIONS : '' };
}

try {
  if (process.argv.length !== 2) throw new Error('usage: node boot-contract.mjs < manifest.json');
  const report = audit(JSON.parse(readFileSync(0, 'utf8')));
  if (report.errors.length) {
    for (const error of report.errors) console.error(`FAIL: ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: boot contract; NODE_OPTIONS=${JSON.stringify(report.nodeOptions)}`);
  }
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
