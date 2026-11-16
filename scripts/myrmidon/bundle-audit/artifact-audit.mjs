#!/usr/bin/env node
// Audit prepared workspace manifests without changing the artifact.
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function glob(pattern) {
  let result = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { result += '.*'; i++; }
      else result += '[^/]*';
    } else result += /[\\^$+.?()|{}[\]]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${result}$`);
}
function audit(input) {
  const root = realpathSync(input);
  if (!statSync(root).isDirectory()) throw new Error('root is not a directory');
  const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const block = workspace.match(/^packages:\s*\n((?:[ \t]+[^\n]*\n|\s*\n)*)/m)?.[1];
  if (!block) throw new Error('missing workspace package patterns');
  const patterns = [...block.matchAll(/^\s*-\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/gm)].map((m) => m[1]);
  if (!patterns.length) throw new Error('missing workspace package patterns');
  const includes = patterns.filter((p) => !p.startsWith('!')).map(glob);
  const excludes = patterns.filter((p) => p.startsWith('!')).map((p) => glob(p.slice(1)));
  const errors = [];
  const packages = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      const rel = relative(root, path).split(sep).join('/');
      if (includes.some((p) => p.test(rel)) && !excludes.some((p) => p.test(rel))) {
        try { if (lstatSync(join(path, 'package.json')).isFile()) packages.push(path); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      walk(path);
    }
  }
  walk(root);
  if (!packages.length) throw new Error('no workspace manifests found');
  function check(dir, field, target) {
    if (typeof target !== 'string') { errors.push(`${field}: invalid runtime target`); return; }
    if (/\.d\.(?:ts|mts|cts)$/.test(target)) return;
    if (/(?:^|\/)src\/.*\.(?:ts|mts|cts)$/.test(target)) errors.push(`${field}: source TypeScript target ${target}`);
    const absolute = resolve(dir, target);
    if (!inside(root, absolute) || isAbsolute(target)) { errors.push(`${field}: target outside root: ${target}`); return; }
    function validate(path) {
      const rel = relative(dir, path).split(sep).join('/');
      if (/\.d\.(?:ts|mts|cts)$/.test(rel)) return;
      if (/(?:^|\/)src\/.*\.(?:ts|mts|cts)$/.test(rel) && target.includes('*')) errors.push(`${field}: source TypeScript target ${rel}`);
      try {
        const actual = realpathSync(path);
        if (!inside(root, actual)) throw new Error('symlink escapes root');
        const canonical = relative(root, actual).split(sep).join('/');
        if (/(?:^|\/)src\/.*\.(?:ts|mts|cts)$/.test(canonical) && !/\.d\.(?:ts|mts|cts)$/.test(canonical)) {
          errors.push(`${field}: source TypeScript target ${canonical}`);
        }
        if (!statSync(actual).isFile()) throw new Error('not a file');
      } catch (error) { errors.push(`${field}: ${target}: ${error.message}`); }
    }
    if (!target.includes('*')) { validate(absolute); return; }
    const prefix = absolute.slice(0, absolute.indexOf('*'));
    const base = prefix.slice(0, prefix.lastIndexOf(sep)) || root;
    const pattern = new RegExp(`^${absolute.split('*').map((part) => part.replace(/[\\^$+.?()|{}[\]]/g, '\\$&')).join('.*')}$`);
    let count = 0;
    function scan(path, ancestors) {
      try {
        const actual = realpathSync(path);
        if (!inside(root, actual)) throw new Error('symlink escapes root');
        const stat = statSync(actual);
        if (stat.isDirectory()) {
          if (ancestors.has(actual)) throw new Error('symlink cycle');
          const next = new Set(ancestors).add(actual);
          for (const name of readdirSync(path)) scan(join(path, name), next);
        } else if (pattern.test(path)) { count++; validate(path); }
      } catch (error) { errors.push(`${field}: ${target}: ${error.message}`); }
    }
    scan(base, new Set());
    if (!count) errors.push(`${field}: no matches for ${target}`);
  }
  function exportsTargets(dir, field, value) {
    if (value === null) return;
    if (typeof value === 'string') { check(dir, field, value); return; }
    if (Array.isArray(value)) { for (const item of value) exportsTargets(dir, field, item); return; }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) if (key !== 'types') exportsTargets(dir, `${field}.${key}`, item);
      return;
    }
    errors.push(`${field}: invalid exports value`);
  }
  for (const dir of packages.sort()) {
    const file = join(dir, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      const label = relative(root, file);
      if (pkg.main !== undefined) check(dir, `${label}:main`, pkg.main);
      if (pkg.exports !== undefined) exportsTargets(dir, `${label}:exports`, pkg.exports);
      if (typeof pkg.bin === 'string') check(dir, `${label}:bin`, pkg.bin);
      else if (pkg.bin && typeof pkg.bin === 'object' && !Array.isArray(pkg.bin)) {
        for (const [name, target] of Object.entries(pkg.bin)) check(dir, `${label}:bin.${name}`, target);
      } else if (pkg.bin !== undefined) errors.push(`${label}: invalid bin`);
    } catch (error) { errors.push(`${relative(root, file)}: ${error.message}`); }
  }
  if (errors.length) { for (const error of errors) console.error(error); process.exitCode = 1; }
  else console.log(`PASS: audited ${packages.length} workspace manifests`);
}
if (process.argv.length !== 3) { console.error('Usage: node artifact-audit.mjs <artifact-root>'); process.exitCode = 1; }
else { try { audit(process.argv[2]); } catch (error) { console.error(`artifact audit: ${error.message}`); process.exitCode = 1; } }
