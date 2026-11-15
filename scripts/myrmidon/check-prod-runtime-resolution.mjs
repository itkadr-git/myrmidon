#!/usr/bin/env node
// Static resolution audit for the compiled server dist tree.
//
// A clean `node server/dist/index.js` reports exactly one unresolved-module
// error per start, so the "run, fix, run" loop is slow and does not converge.
// This check performs the same resolution work up front, without starting the
// server or requiring tsx/network/database, and reports every failure at once.
//
// Why a scan instead of a bundle: the server is not bundled on purpose. Many
// modules resolve sibling artifacts relative to `import.meta.url` at whatever
// nesting depth their source file sits at (onboarding assets, built-ins,
// services/scripts, the vendored runner tree), and bundling collapses that
// layout (see server/scripts/verify-runner-vendor-dependencies.mjs for the
// same reasoning). So we compile with tsc, ship the dist tree as-is, and this
// script audits the shipped tree instead.
//
// What is checked, per compiled .js file under --dist:
//   - static `import ... from "..."`, `export ... from "..."`,
//     side-effect `import "..."`, and dynamic `import("...")` with a string
//     literal argument;
//   - `@myrmidon/<name>[/subpath]` specifiers are resolved the way Node does:
//     walk up from the importing file's directory through
//     node_modules/@myrmidon/<name>; with no such link, fall back to Node's
//     self-reference rule: the nearest package.json above the importing file
//     whose `name` equals the specifier's package, resolved through its own
//     `exports` map. Read that map, pick the target by
//     `import`/`node`/`default` conditions (string targets and `./*`
//     patterns included), then verify the target file exists and is
//     compiled JS (not `.ts`, not under `/src/`). Reached package files are
//     then walked recursively for their own imports;
//   - compiled test artifacts (`*.test.js`, `*.myrmidon.test.js`) are never
//     loaded by the production runtime and are skipped;
//   - relative specifiers ending in `.ts`;
//   - `new URL("....ts", import.meta.url)` string literals.
// Non-@myrmidon npm packages are intentionally not checked for existence;
// that is server/scripts/verify-runner-vendor-dependencies.mjs's job.
//
// Usage:
//   node scripts/myrmidon/check-prod-runtime-resolution.mjs --dist server/dist [--skip-vendor-runner]
//
// --skip-vendor-runner ignores dist/vendor/paperclip-runner (a copy of the
// prebuilt runner runtime; it is not buildable in sandboxes without a
// writable CARGO_HOME). Do NOT pass the flag when building the image.
//
// Output: one `file:line specifier → reason` line per failure, then a
// "N сбоев в M пакетах" summary. Exit code 1 on any failure, 0 when clean.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_CONDITIONS = new Set(["import", "node", "default"]);
const JS_EXT = /\.(?:js|mjs|cjs)$/;
// Compiled-in dist test artifacts: vitest/node test files that tsc emits next
// to the runtime output. The production runtime never imports them, so the
// audit skips them (their `new URL("../src/x.ts")` fixtures are expected).
const TEST_ARTIFACT_EXT = /(?:^|\.)test\.js$|\.myrmidon\.test\.js$/;

// ---------------------------------------------------------------------------
// Source scanning: collect import-like string literals with line numbers.
// ---------------------------------------------------------------------------

/**
 * Collect `'`/`"` string literals that sit in real code positions, skipping
 * comments and template literals (a specifier must be a string literal; a
 * template-literal `import()` is dynamic and not statically checkable).
 * Returns spans { start, end, value } so callers can inspect the code text
 * immediately around each literal.
 */
export function scanCodeStringLiterals(text) {
  const spans = [];
  const n = text.length;
  let i = 0;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < n) {
    const c = text[i];
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && text[i + 1] === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      let value = "";
      i += 1;
      while (i < n) {
        const ch = text[i];
        if (ch === "\\") {
          value += text[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (ch === "\n") break; // unterminated; stop at end of line
        if (ch === c) {
          i += 1;
          break;
        }
        value += ch;
        i += 1;
      }
      spans.push({ start, end: i, value });
      continue;
    }
    if (c === "`") {
      i = skipTemplate(text, i);
      continue;
    }
    i += 1;
  }
  return spans;
}


function skipString(text, i) {
  const q = text[i];
  i += 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === q) return i + 1;
    if (c === "\n") return i; // unterminated
    i += 1;
  }
  return n;
}

function skipTemplate(text, i) {
  // text[i] === "`"
  i += 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") return i + 1;
    if (c === "$" && text[i + 1] === "{") {
      i = skipBraces(text, i + 2);
      continue;
    }
    i += 1;
  }
  return n;
}

function skipBraces(text, i) {
  // Inside a `${ ... }` interpolation, one brace deep.
  const n = text.length;
  let depth = 1;
  while (i < n && depth > 0) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === "}") {
      depth -= 1;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(text, i);
      continue;
    }
    i += 1;
  }
  return i;
}

function lineAt(text, lineStarts, pos) {
  // 1 + number of newlines strictly before pos, via binary search.
  let lo = 0;
  let hi = lineStarts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/**
 * Extract import-like specifiers: { kind, specifier, line }.
 * kind: "from" (static/export-from), "import" (side-effect or dynamic call
 * with a string literal), "url" (new URL("...", import.meta.url)).
 */
export function scanImports(text) {
  const spans = scanCodeStringLiterals(text);
  const lineStarts = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }
  const results = [];
  const seen = new Set();
  for (const span of spans) {
    if (span.value === "") continue;
    const before = text.slice(Math.max(0, span.start - 80), span.start).replace(/\s+$/, "");
    const after = text.slice(span.end, span.end + 60);
    let kind = null;
    if (/import\s*\($/.test(before) && /^\s*[),]/.test(after)) {
      kind = "import"; // dynamic import("...")
    } else if (/new\s+URL\s*\($/.test(before) && /^\s*,\s*import\s*\.\s*meta\s*\.\s*url/.test(after)) {
      kind = "url";
    } else if (/(?:^|[^\w.$])import$/.test(before)) {
      kind = "import"; // side-effect import "..."
    } else if (/from$/.test(before)) {
      kind = "from";
    } else {
      continue;
    }
    const line = lineAt(text, lineStarts, span.start);
    const key = `${line}\u0000${span.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ kind, specifier: span.value, line });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Node-style package resolution for @myrmidon/* specifiers.
// ---------------------------------------------------------------------------

function findPackageDir(fromDir, pkgName) {
  let dir = resolve(fromDir);
  for (;;) {
    const candidate = join(dir, "node_modules", pkgName);
    if (existsSync(candidate)) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Node's self-reference rule: an `@myrmidon/<pkg>/...` import from inside
 * package `<pkg>` itself resolves through that package's own package.json
 * (`name` must match, `exports` must exist) — pnpm creates no self-link in
 * node_modules for private workspace packages, so findPackageDir alone misses
 * these. Walk up from fromDir to the nearest package.json and return its
 * directory when it is the referenced package with an exports map.
 */
function findSelfReferenceDir(fromDir, pkgName) {
  let dir = resolve(fromDir);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) {
      const pkgJson = readPackageJson(dir);
      if (pkgJson && pkgJson.name === pkgName && pkgJson.exports !== undefined) {
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readPackageJson(pkgDir) {
  try {
    return JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function patternMatch(pattern, subpath) {
  const star = pattern.indexOf("*");
  const head = pattern.slice(0, star);
  const tail = pattern.slice(star + 1);
  if (subpath.length < head.length + tail.length) return null;
  if (!subpath.startsWith(head) || !subpath.endsWith(tail)) return null;
  return subpath.slice(head.length, subpath.length - tail.length);
}

function resolveConditions(obj) {
  // Node picks the first matching condition in object insertion order;
  // `types` is TypeScript-only and deliberately not a runtime condition.
  for (const [key, value] of Object.entries(obj)) {
    if (!RUNTIME_CONDITIONS.has(key)) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        const resolved =
          typeof item === "string" ? item : item && typeof item === "object" ? resolveConditions(item) : null;
        if (typeof resolved === "string") return resolved;
      }
      continue;
    }
    if (value && typeof value === "object") {
      const resolved = resolveConditions(value);
      if (typeof resolved === "string") return resolved;
    }
  }
  return null;
}

/**
 * Resolve `subpath` against a package's exports map.
 * Returns a relative target string, `null` when no runtime condition matches,
 * or `undefined` when the subpath is not exported at all.
 */
export function matchExportsTarget(exportsField, main, subpath) {
  if (exportsField === undefined || exportsField === null) {
    // Legacy package without an exports map.
    if (subpath === ".") {
      let entry = main || "index.js";
      if (!/\.(?:js|mjs|cjs|ts|d\.ts)$/.test(entry)) entry += ".js";
      return entry;
    }
    return subpath.slice(1); // "./lib/x.js" -> "lib/x.js"
  }
  if (typeof exportsField === "string") {
    return subpath === "." ? exportsField : undefined;
  }
  if (Array.isArray(exportsField)) {
    for (const item of exportsField) {
      const resolved = matchExportsTarget(item, main, subpath);
      if (typeof resolved === "string") return resolved;
    }
    return null;
  }
  const keys = Object.keys(exportsField);
  const isSubpathMap = keys.length > 0 && keys.every((k) => k === "." || k.startsWith("./"));
  if (!isSubpathMap) {
    // Conditions object for the "." entry.
    if (subpath !== ".") return undefined;
    return resolveConditions(exportsField);
  }
  const exact = exportsField[subpath];
  if (exact !== undefined) {
    return typeof exact === "string" ? exact : resolveConditions(exact);
  }
  for (const [key, value] of Object.entries(exportsField)) {
    if (!key.includes("*")) continue;
    const star = patternMatch(key, subpath);
    if (star === null) continue;
    const resolved = typeof value === "string" ? value : resolveConditions(value);
    if (typeof resolved !== "string") continue;
    return resolved.includes("*") ? resolved.replaceAll("*", star) : resolved;
  }
  return undefined;
}

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Resolve one `@myrmidon/*` specifier the way Node would.
 * Returns { failure, packageName } on a resolution failure, or
 * { pkgDir, packageName, follow } when the target is compiled JS that exists
 * (follow = absolute path to keep walking).
 */
export function resolveMyrmidonSpecifier(specifier, fromDir) {
  const segments = specifier.split("/");
  const pkgName = `${segments[0]}/${segments[1]}`;
  const rest = segments.slice(2);
  const subpath = rest.length > 0 ? `./${rest.join("/")}` : ".";
  const pkgDir = findPackageDir(fromDir, pkgName) ?? findSelfReferenceDir(fromDir, pkgName);
  if (!pkgDir) return { failure: "пакет не найден в node_modules", packageName: pkgName };
  const pkgJson = readPackageJson(pkgDir);
  if (!pkgJson) return { failure: "package.json не читается", packageName: pkgName };
  const target = matchExportsTarget(pkgJson.exports, pkgJson.main, subpath);
  if (target === undefined) return { failure: "подпуть не экспортируется", packageName: pkgName };
  if (target === null) return { failure: "нет подходящего условия exports", packageName: pkgName };
  if (target.endsWith(".d.ts")) {
    // Type-only target: never a runtime failure, never followed.
    return { pkgDir, packageName: pkgName, follow: null };
  }
  if (target.endsWith(".ts")) return { failure: "exports указывает на .ts", packageName: pkgName };
  if (target.split("/").includes("src")) return { failure: "exports указывает в src/", packageName: pkgName };
  const abs = resolve(pkgDir, target);
  let stat = null;
  try {
    stat = statSync(abs);
  } catch {
    stat = null;
  }
  if (!stat) return { failure: "файл не собран", packageName: pkgName };
  if (!stat.isFile()) return { failure: "цель exports не файл", packageName: pkgName };
  return { pkgDir, packageName: pkgName, follow: safeRealpath(abs) };
}

function resolveRelativeImport(fromFile, specifier) {
  let p = resolve(dirname(fromFile), specifier);
  if (!JS_EXT.test(p) && !p.endsWith(".ts") && !p.endsWith(".d.ts")) p += ".js";
  return p;
}

// ---------------------------------------------------------------------------
// dist walking and the failure walk.
// ---------------------------------------------------------------------------

function isVendorRunnerPath(distRoot, p) {
  const rel = relative(distRoot, p);
  const vendor = join("vendor", "paperclip-runner");
  return rel === vendor || rel.startsWith(vendor + sep);
}

export function walkJsFiles(distRoot, skipVendorRunner = false) {
  const files = [];
  const stack = [resolve(distRoot)];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipVendorRunner && isVendorRunnerPath(distRoot, p)) continue;
        stack.push(p);
      } else if (entry.isFile() && JS_EXT.test(entry.name) && !TEST_ARTIFACT_EXT.test(entry.name)) {
        files.push(p);
      }
    }
  }
  return files.sort();
}

/**
 * Walk every compiled .js file under distRoot plus every package file reached
 * through @myrmidon/* or in-package relative imports, and report every
 * resolution failure (never just the first).
 */
export function collectFailures(distRoot, options = {}) {
  const failures = [];
  const visited = new Set();
  const queue = walkJsFiles(distRoot, options.skipVendorRunner === true).map((file) => ({ file, pkgDir: null }));
  while (queue.length > 0) {
    const { file, pkgDir } = queue.pop();
    const real = safeRealpath(file);
    if (visited.has(real)) continue;
    visited.add(real);
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      failures.push({ file, line: 0, specifier: "-", reason: "файл не читается", packageName: null });
      continue;
    }
    for (const imp of scanImports(text)) {
      const spec = imp.specifier;
      if (imp.kind === "url") {
        if (spec.endsWith(".ts") && !spec.endsWith(".d.ts")) {
          failures.push({
            file,
            line: imp.line,
            specifier: spec,
            reason: "new URL указывает на .ts",
            packageName: null,
          });
        }
        continue;
      }
      if (spec.startsWith("@myrmidon/")) {
        const outcome = resolveMyrmidonSpecifier(spec, dirname(file));
        if (outcome.failure) {
          failures.push({ file, line: imp.line, specifier: spec, reason: outcome.failure, packageName: outcome.packageName });
        } else if (outcome.follow && JS_EXT.test(outcome.follow)) {
          queue.push({ file: outcome.follow, pkgDir: outcome.pkgDir });
        }
        continue;
      }
      if (spec.startsWith(".")) {
        if (spec.endsWith(".d.ts")) continue;
        if (spec.endsWith(".ts")) {
          failures.push({ file, line: imp.line, specifier: spec, reason: "относительный импорт .ts", packageName: null });
          continue;
        }
        // Inside a package, follow relative imports so the reached package
        // graph is checked for its own @myrmidon/* imports too. dist-internal
        // relative imports are tsc's job and are skipped.
        if (pkgDir) {
          const target = resolveRelativeImport(file, spec);
          if (JS_EXT.test(target) && existsSync(target)) {
            queue.push({ file: target, pkgDir });
          }
        }
      }
    }
  }
  failures.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return failures;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { dist: null, skipVendorRunner: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dist") {
      args.dist = argv[i + 1];
      if (args.dist === undefined) throw new Error("--dist требует путь к собранному каталогу");
      i += 1;
    } else if (arg.startsWith("--dist=")) {
      args.dist = arg.slice("--dist=".length);
    } else if (arg === "--skip-vendor-runner") {
      args.skipVendorRunner = true;
    } else {
      throw new Error(`неизвестный аргумент: ${arg}`);
    }
  }
  if (!args.dist) throw new Error("укажите --dist <путь к собранному dist сервера>");
  return args;
}

function pluralRu(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function displayPath(file, cwd) {
  const rel = relative(cwd, file);
  return rel.startsWith("..") ? file : rel;
}

export function formatFailures(failures, cwd = process.cwd()) {
  return failures.map((f) => `${displayPath(f.file, cwd)}:${f.line} ${f.specifier} → ${f.reason}`);
}

export function formatSummary(failures) {
  const packages = new Set(failures.map((f) => f.packageName).filter(Boolean));
  const n = failures.length;
  const m = packages.size;
  return `${n} ${pluralRu(n, "сбой", "сбоя", "сбоев")} в ${m} ${pluralRu(m, "пакете", "пакетах", "пакетах")}`;
}

export function main(argv = process.argv.slice(2), log = console, cwd = process.cwd()) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    log.error(`check-prod-runtime-resolution: ${error.message}`);
    return 2;
  }
  const distRoot = resolve(cwd, args.dist);
  if (!existsSync(distRoot) || !statSync(distRoot).isDirectory()) {
    log.error(`check-prod-runtime-resolution: dist не найден: ${args.dist} (сначала соберите сервер)`);
    return 2;
  }
  const failures = collectFailures(distRoot, { skipVendorRunner: args.skipVendorRunner });
  for (const line of formatFailures(failures, cwd)) log.error(line);
  const summary = formatSummary(failures);
  if (failures.length > 0) log.error(summary);
  else log.log(summary);
  return failures.length > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
