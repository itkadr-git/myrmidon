#!/usr/bin/env node
// myrmidon(1.6.5 SQL-TEMPLATE-LINT): a CI gate against the bug class that killed
// the review-rework loop (`like $6%` — Postgres syntax error, 23 failures per
// 15 minutes on the live board). In a drizzle `sql` template every `${...}`
// becomes a positional parameter ($1, $2, ...). A `%` wildcard left in the
// literal text right AFTER a closing interpolation (`... ${pat}%`) or right
// BEFORE an opening one (`like %${pat}`) is no longer part of a string value —
// the wire sees bare SQL (`like $6%`) and Postgres refuses it with a syntax
// error that only surfaces at runtime. Wildcards belong INSIDE the interpolated
// value (`` like ${`${term}%`} ``), which this scan ignores by construction:
// it inspects only the literal text between interpolations.
//
//   node scripts/myrmidon/ci/sql-template-lint.mjs [--root <dir>] [--files f1.ts ...]
//
// Default root: server/src. Every *.ts file with a `sql\`` template is scanned
// (`sql.raw\`` is a plain string construct and is not flagged). Output: one
// line per violation. Exit 0 clean, exit 1 violations found, exit 2 usage
// errors. Node built-ins only (same contract as change-fragments-gate.mjs).

import fs from "node:fs";
import path from "node:path";

const DEFAULT_ROOT = "server/src";

/**
 * Skip a JS string literal: `i` is the index of the opening quote. Returns the
 * index after the closing quote (or end of source).
 */
export function skipString(source, i, quote) {
  i += 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

/**
 * Skip a template literal: `i` is the index of the opening backtick. Handles
 * escaped characters and nested `${ ... }` expressions. Returns the index
 * after the closing backtick.
 */
export function skipTemplate(source, i) {
  i += 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") return i + 1;
    if (ch === "$" && source[i + 1] === "{") {
      i = skipExpression(source, i + 1);
      continue;
    }
    i += 1;
  }
  return i;
}

/**
 * Skip a `${ ... }` expression body: `i` is the index of the opening brace.
 * Strings, template literals (recursively) and comments are consumed as
 * units so their braces never confuse the depth counter. Returns the index
 * after the matching closing brace.
 */
export function skipExpression(source, i) {
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"') {
      i = skipString(source, i, ch);
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(source, i);
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      i += 1;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return i;
}

/**
 * Collect the literal text parts of one template opened at the backtick
 * `open`: each entry is { start, end } (absolute offsets, half-open). Parts
 * between interpolations end where the `${` begins; the part after an
 * interpolation starts right after its `}`.
 */
export function templateTextParts(source, open) {
  const parts = [];
  let i = open + 1;
  let segStart = i;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      parts.push({ start: segStart, end: i });
      return { parts, close: i };
    }
    if (ch === "$" && source[i + 1] === "{") {
      parts.push({ start: segStart, end: i });
      i = skipExpression(source, i + 1);
      segStart = i;
      // an interpolation may close the template right after `}` is impossible;
      // resume scanning template text
      continue;
    }
    i += 1;
  }
  parts.push({ start: segStart, end: source.length });
  return { parts, close: source.length };
}

/**
 * Lint one source text. Finds every `sql` template (the identifier `sql`
 * directly followed by a backtick; `sql.raw(...)` and plain template literals
 * are not scanned) and flags a literal `%` glued to an interpolation edge:
 *   - `after-interpolation`: part of text starting (whitespace ignored) with
 *     `%` that does NOT begin the template (so it follows a `}`);
 *   - `before-interpolation`: part of text ending with `%` (whitespace
 *     ignored) that is followed by a `${` inside the same template.
 * Returns an array of { file, line, column, kind, snippet }.
 */
export function lintSqlTemplates(source, fileName = "<source>") {
  const violations = [];
  const lineStarts = computeLineStarts(source);
  const push = (offset, kind, partText) => {
    const pos = locate(lineStarts, offset);
    const lineStart = lineStarts[pos.line - 1];
    const lineEnd = lineStarts[pos.line] ?? source.length;
    const snippet = source.slice(lineStart, lineEnd).trim().slice(0, 120);
    violations.push({ file: fileName, line: pos.line, column: pos.column, kind, snippet });
    void partText;
  };
  const re = /\bsql`/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const open = match.index + match[0].length - 1;
    const { parts, close } = templateTextParts(source, open);
    for (let idx = 0; idx < parts.length; idx += 1) {
      const part = parts[idx];
      const text = source.slice(part.start, part.end);
      if (text.length === 0) continue;
      // `} %` — the part is not the leading text, so it follows an interpolation.
      if (idx > 0 && /^\s*%/.test(text)) {
        push(part.start + text.search(/%/), "after-interpolation", text);
      }
      // `% ${` — this part is followed by an interpolation inside the template.
      const hasNextInterpolation = idx + 1 < parts.length;
      if (hasNextInterpolation && /%\s*$/.test(text)) {
        // the last `%` in the part is the one glued to the opening `${`
        const pctInPart = text.lastIndexOf("%");
        push(part.start + pctInPart, "before-interpolation", text);
      }
    }
    re.lastIndex = skipTemplate(source, open);
    void close;
  }
  return violations;
}

function computeLineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function locate(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
}

/** Every *.ts file under `root` (skips node_modules and dot-directories). */
export function collectTsFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(full);
      } else if (entry.isFile() && full.endsWith(".ts")) {
        out.push(full);
      }
    }
  };
  if (fs.statSync(root).isDirectory()) walk(root);
  else out.push(root);
  return out.sort();
}

/** Lint a list of file paths; violations carry paths relative to `cwdRoot`. */
export function lintPaths(files, cwdRoot = process.cwd()) {
  const violations = [];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    if (!/(?<![A-Za-z0-9_.])sql`/.test(source)) continue;
    const rel = path.relative(cwdRoot, file) || file;
    for (const v of lintSqlTemplates(source, rel)) violations.push(v);
  }
  return violations;
}

export function formatViolations(violations) {
  return violations.map(
    (v) =>
      `${v.file}:${v.line}:${v.column}: ${v.kind}: '%' glued to a sql-template interpolation edge ` +
      `(the wildcard leaves the parameter and reaches the wire as bare SQL, e.g. 'like $6%'): ${v.snippet}`,
  );
}

function parseArgs(argv) {
  const opts = { root: DEFAULT_ROOT, files: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") {
      opts.root = argv[++i];
    } else if (argv[i] === "--files") {
      opts.files = argv.slice(i + 1);
      break;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      opts.help = true;
    } else {
      return { bad: true };
    }
  }
  return opts;
}

const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === pathToFileUrl(path.resolve(process.argv[1]));

function pathToFileUrl(absPath) {
  return "file://" + (absPath.startsWith("/") ? absPath : "/" + absPath);
}

export { invokedDirectly, parseArgs, pathToFileUrl };

if (invokedDirectly) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      "usage: node scripts/myrmidon/ci/sql-template-lint.mjs [--root <dir>] [--files f1.ts f2.ts]\n",
    );
    process.exit(0);
  }
  if (opts.bad) {
    process.stderr.write("sql-template-lint: unrecognized arguments\n");
    process.exit(2);
  }
  const targets = opts.files ?? [opts.root];
  const existing = targets.filter((p) => fs.existsSync(p));
  if (existing.length === 0) {
    process.stderr.write(`sql-template-lint: none of the paths exist: ${targets.join(", ")}\n`);
    process.exit(2);
  }
  const files = existing.flatMap((p) => (fs.statSync(p).isDirectory() ? collectTsFiles(p) : [p]));
  const violations = lintPaths(files, process.cwd());
  if (violations.length > 0) {
    process.stderr.write(`${formatViolations(violations).join("\n")}\n`);
    process.stderr.write(
      "\nsql-template-lint: " +
        violations.length +
        " violation(s). Put the wildcard INSIDE the interpolated value" +
        " (a sql template turns every ${...} into a $n parameter; a '%' left in the\n" +
        "template text next to an edge reaches Postgres as bare SQL: 'like $6%').\n",
    );
    process.exit(1);
  }
  process.stdout.write(`sql-template-lint: clean (${files.length} file(s) scanned)\n`);
  process.exit(0);
}
