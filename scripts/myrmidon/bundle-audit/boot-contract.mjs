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
    else if (/[ \t\n\r\v\f]/.test(char) && !quoted) {
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
  const memoryLimits = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { errors: ['manifest must be an object'] };
  const { argv, env } = manifest;
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) {
    errors.push('argv must be an array of strings, not a shell command');
  } else {
    if (argv.length !== 2 || argv[0] !== 'node' || argv[1] !== 'server/dist/index.js') errors.push('argv must be exactly node server/dist/index.js');
    for (const arg of argv) {
      if (/^--(?:experimental[-_])?loader(?:=|$)/i.test(arg)) errors.push('argv contains forbidden runtime option: loader');
      else if (/^--import(?:=|$)/i.test(arg)) errors.push('argv contains forbidden runtime option: import');
      else if (/(?:^|[/\\@])(?:tsx|ts-node)(?:$|[/\\@=.-])/i.test(arg)) errors.push('argv contains forbidden runtime option: TypeScript runtime');
    }
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    errors.push('env must be an object');
  } else {
    for (const [name, value] of Object.entries(env)) {
      if (!name || name.includes('=') || name.includes('\u0000')) errors.push('env name is invalid');
      if (typeof value !== 'string') errors.push('env values must be strings');
      else if (value.includes('\u0000')) errors.push('env value contains NUL');
    }
    for (const name of ['VERSION', 'COMMIT']) {
      const value = env[`MYRMIDON_BUILD_${name}`];
      if (typeof value !== 'string' || !value.trim() || /^(unknown|null|undefined)$/i.test(value.trim())) errors.push(`missing or unknown build ${name.toLowerCase()} stamp`);
    }
    if (env.NODE_OPTIONS !== undefined && typeof env.NODE_OPTIONS === 'string') {
      try {
        const tokens = optionsTokens(env.NODE_OPTIONS);
        for (let i = 0; i < tokens.length; i++) {
          const token = tokens[i];
          if (/^--(?:experimental[-_])?loader(?:=|$)/i.test(token)) errors.push('NODE_OPTIONS contains forbidden runtime option: loader');
          else if (/^--import(?:=|$)/i.test(token)) errors.push('NODE_OPTIONS contains forbidden runtime option: import');
          else if (/(?:^|[/\\@])(?:tsx|ts-node)(?:$|[/\\@=.-])/i.test(token)) errors.push('NODE_OPTIONS contains forbidden runtime option: TypeScript runtime');
          else if (token === '--max-old-space-size' || token.startsWith('--max-old-space-size=')) {
            const value = token === '--max-old-space-size' ? tokens[++i] : token.slice('--max-old-space-size='.length);
            if (value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0) memoryLimits.push(Number(value));
            else errors.push('NODE_OPTIONS has invalid max-old-space-size');
          } else errors.push('NODE_OPTIONS contains an unsupported option');
        }
      } catch (error) { errors.push(error.message); }
    }
  }
  return { errors, memoryLimits };
}

try {
  if (process.argv.length !== 2) throw new Error('usage: node boot-contract.mjs < manifest.json');
  const report = audit(JSON.parse(readFileSync(0, 'utf8')));
  if (report.errors.length) {
    for (const error of report.errors) console.error(`FAIL: ${error}`);
    process.exitCode = 1;
  } else {
    const limits = report.memoryLimits.map((value) => `--max-old-space-size=${value}`).join(' ');
    console.log(`PASS: boot contract; NODE_OPTIONS=${limits}`);
  }
} catch (error) {
  console.error('FAIL: invalid input or invocation');
  process.exitCode = 1;
}
