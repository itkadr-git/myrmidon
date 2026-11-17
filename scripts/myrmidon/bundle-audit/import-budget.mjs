#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';

// Tokenize without evaluating source. Non-literal expressions are deliberately ignored.
function regexAllowed(result) {
  const last = result.at(-1)?.value;
  if (last === '}' && result.at(-1)?.statementBlock) return true;
  if (!result.length || /^[({[=,:;!?&|+*~<>-]$/.test(last) ||
      ['return', 'throw', 'case', 'delete', 'void', 'typeof', 'yield', 'await', 'in', 'instanceof'].includes(last)) return true;
  if (last !== ')') return false;
  let depth = 0;
  for (let j = result.length - 1; j >= 0; j--) {
    if (result[j].value === ')') depth++;
    if (result[j].value === '(' && --depth === 0) return ['if', 'while', 'for', 'with', 'switch', 'catch'].includes(result[j - 1]?.value);
  }
  return false;
}

function regexEnd(source, start) {
  let j = start + 1, inClass = false;
  while (j < source.length) {
    if (source[j] === '\\') { j += 2; continue; }
    if (source[j] === '[') inClass = true;
    if (source[j] === ']' && inClass) inClass = false;
    if (source[j] === '/' && !inClass) { j++; while (j < source.length && /[dgimsuvy]/.test(source[j])) j++; return j; }
    if (source[j] === '\n') break;
    j++;
  }
  return null;
}

function tokens(source, allowHashbang = false) {
  const result = [];
  let i = 0;
  if (allowHashbang && source.startsWith('#!')) {
    const end = source.search(/[\r\n\u2028\u2029]/);
    i = end < 0 ? source.length : end;
  }
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (source.startsWith('//', i)) { i = source.indexOf('\n', i + 2); if (i < 0) break; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c; let value = ''; let escaped = false; i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') { escaped = true; value += source.slice(i, i + 2); i += 2; continue; }
        if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
          let depth = 1, start = i + 2; i += 2;
          while (i < source.length && depth) {
            if (source[i] === '\\') { i += 2; continue; }
            if (source.startsWith('//', i)) {
              const end = source.indexOf('\n', i + 2); i = end < 0 ? source.length : end; continue;
            }
            if (source.startsWith('/*', i)) {
              const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue;
            }
            if (source[i] === '"' || source[i] === "'") {
              const innerQuote = source[i++];
              while (i < source.length && source[i] !== innerQuote) {
                if (source[i] === '\\') i++;
                i++;
              }
              if (i < source.length) i++;
              continue;
            }
            if (source[i] === '/' && regexAllowed(tokens(source.slice(start, i)))) {
              const end = regexEnd(source, i);
              if (end !== null) { i = end; continue; }
            }
            if (source[i] === '{') depth++;
            if (source[i] === '}') depth--;
            i++;
          }
          result.push({ type: 'opaque', value: '' }, ...tokens(source.slice(start, i - 1)));
          continue;
        }
        value += source[i++];
      }
      i++;
      if (quote !== '`' && escaped) {
        value = value.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, escape) => {
          if (escape[0] === 'u' || escape[0] === 'x') return String.fromCodePoint(parseInt(escape.slice(1), 16));
          return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }[escape] ?? escape);
        });
      }
      result.push({ type: quote === '`' ? 'opaque' : 'string', value });
      continue;
    }
    const closesControlCondition = () => {
      if (result.at(-1)?.value !== ')') return false;
      let depth = 0;
      for (let j = result.length - 1; j >= 0; j--) {
        if (result[j].value === ')') depth++;
        if (result[j].value === '(' && --depth === 0) {
          return ['if', 'while', 'for', 'with', 'switch', 'catch'].includes(result[j - 1]?.value);
        }
      }
      return false;
    };
    if (c === '/' && source[i + 1] !== '/' && source[i + 1] !== '*' && regexAllowed(result)) {
      let j = i + 1; let inClass = false; let closed = false;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '[') inClass = true;
        if (source[j] === ']' && inClass) inClass = false;
        if (source[j] === '/' && !inClass) { j++; while (j < source.length && /[dgimsuvy]/.test(source[j])) j++; closed = true; break; }
        if (source[j] === '\n') break;
        j++;
      }
      if (closed) { i = j; result.push({ type: 'opaque', value: '' }); continue; }
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i++; while (i < source.length && /[\w$]/.test(source[i])) i++;
      result.push({ type: 'word', value: source.slice(start, i) }); continue;
    }
    if (c === '{') {
      const previous = result.at(-1)?.value;
      const statementBlock = !result.length || closesControlCondition() ||
        ['else', 'try', 'finally', 'do', ';'].includes(previous) ||
        (previous === '}' && result.at(-1)?.statementBlock);
      result.push({ type: 'punct', value: c, statementBlock }); i++; continue;
    }
    if (c === '}') {
      let depth = 0, statementBlock = false;
      for (let j = result.length - 1; j >= 0; j--) {
        if (result[j].value === '}') depth++;
        if (result[j].value === '{' && depth-- === 0) { statementBlock = result[j].statementBlock; break; }
      }
      result.push({ type: 'punct', value: c, statementBlock }); i++; continue;
    }
    result.push({ type: 'punct', value: c }); i++;
  }
  return result;
}

function imports(source) {
  const t = tokens(source, true), found = [];
  const value = i => t[i]?.value;
  const literal = i => t[i]?.type === 'string';
  const add = (i, kind) => { if (literal(i)) found.push({ specifier: value(i), kind }); };
  for (let i = 0; i < t.length; i++) {
    if (value(i - 1) === '.' || value(i - 1) === '?.') continue;
    if (value(i) === 'require' && value(i + 1) === '(' && literal(i + 2) && value(i + 3) === ')') add(i + 2, 'eager');
    if (value(i) === 'import') {
      if (value(i + 1) === '(') { if (literal(i + 2) && [')', ','].includes(value(i + 3))) add(i + 2, 'lazy'); continue; }
      if (literal(i + 1)) { add(i + 1, 'eager'); continue; }
    }
    if (value(i) === 'export' && !['{', '*'].includes(value(i + 1))) continue;
    if (value(i) === 'import' || value(i) === 'export') {
      for (let j = i + 1; j < t.length && value(j) !== ';'; j++) {
        if (value(j) === 'from' && literal(j + 1)) { add(j + 1, 'eager'); break; }
        if (value(j) === 'import' || value(j) === 'export') break;
      }
    }
  }
  return found;
}

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
function fileFor(path) {
  for (const candidate of [path, ...(!extname(path) ? ['.js', '.mjs', '.cjs', '/index.js', '/index.mjs', '/index.cjs'].map(x => path + x) : [])]) {
    try { if (statSync(candidate).isFile()) return candidate; } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  return null;
}
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function audit(entry) {
  const root = dirname(entry), display = path => relative(root, path).split(sep).join('/');
  const modules = new Map(), edges = new Map(), queue = [entry];
  while (queue.length) {
    const file = queue.shift(); if (modules.has(file)) continue;
    const buffer = readFileSync(file); modules.set(file, { path: display(file), bytes: buffer.length, eager: false });
    for (const imp of imports(buffer.toString('utf8'))) {
      if (builtins.has(imp.specifier)) continue;
      const local = imp.specifier.startsWith('.') || isAbsolute(imp.specifier);
      const target = local ? fileFor(resolve(dirname(file), imp.specifier)) : null;
      const edge = { from: display(file), specifier: imp.specifier, kind: imp.kind, to: target ? display(target) : null };
      edges.set(JSON.stringify(edge), edge);
      if (target && !modules.has(target)) queue.push(target);
    }
  }
  const list = [...edges.values()].sort((a, b) => cmp(a.from, b.from) || cmp(a.specifier, b.specifier) || cmp(a.kind, b.kind));
  const byPath = new Map([...modules.values()].map(m => [m.path, m]));
  const pending = [display(entry)];
  while (pending.length) {
    const name = pending.pop(), mod = byPath.get(name); if (!mod || mod.eager) continue; mod.eager = true;
    for (const edge of list) if (edge.from === name && edge.kind === 'eager' && edge.to) pending.push(edge.to);
  }
  const all = [...byPath.values()].sort((a, b) => cmp(a.path, b.path));
  const eager = all.filter(m => m.eager);
  return { entry: display(entry), modules: all, edges: list, unknown: list.filter(e => !e.to).sort((a, b) => cmp(a.specifier, b.specifier) || cmp(a.from, b.from)), counts: { modules: all.length, eagerModules: eager.length, edges: list.length }, bytes: { total: all.reduce((n, m) => n + m.bytes, 0), eager: eager.reduce((n, m) => n + m.bytes, 0) }, heaviestEager: [...eager].sort((a, b) => b.bytes - a.bytes || cmp(a.path, b.path)).slice(0, 10) };
}

try {
  if (process.argv.length !== 3) throw new Error('Usage: node import-budget.mjs <entry>');
  const entry = fileFor(resolve(process.argv[2]));
  if (!entry) throw new Error('Entry file not found');
  process.stdout.write(`${JSON.stringify(audit(entry), null, 2)}\n`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
