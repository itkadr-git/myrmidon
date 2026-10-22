// myrmidon(1.6.5 SQL-TEMPLATE-LINT): node:test suite of the sql-template lint
// (see sql-template-lint.mjs). Pinned: the `like $6%` bug class that killed the
// review-rework loop is flagged in both edge positions; wildcards correctly
// interpolated INSIDE a value are not flagged; `sql.raw` strings and non-sql
// templates are out of scope; the shipped review-rework fix stays clean.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import {
  lintSqlTemplates,
  collectTsFiles,
  formatViolations,
  parseArgs,
  skipTemplate,
  templateTextParts,
} from "./sql-template-lint.mjs";

const kinds = (violations) => violations.map((v) => v.kind);

test("flags a wildcard left after a closing interpolation (the review-rework bug)", () => {
  const source =
    "const q = sql`${issueWorkProducts.url} like ${\"%/x/\" + n}%`;\n";
  const v = lintSqlTemplates(source, "a.ts");
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, "after-interpolation");
  assert.equal(v[0].line, 1);
});

test("flags a wildcard sitting before an opening interpolation", () => {
  const source = "const q = sql`select 1 where body like %${pattern}`;\n";
  const v = lintSqlTemplates(source, "a.ts");
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, "before-interpolation");
});

test("accepts a wildcard inside the interpolated value", () => {
  const source = "const q = sql`${chatActions.payload}::text like ${`%${marker}%`}`;\n";
  assert.deepEqual(lintSqlTemplates(source, "a.ts"), []);
});

test("accepts a wildcard inside its own interpolation on both ends", () => {
  const source = "const q = sql`where body like ${`${term}%`}`;\n";
  assert.deepEqual(lintSqlTemplates(source, "a.ts"), []);
});

test("ignores percent arithmetic in sql.raw strings (not a parameterized template)", () => {
  const source = "await db.execute(sql.raw(`SELECT (s % ${agentCount}) FROM t`));\n";
  assert.deepEqual(lintSqlTemplates(source, "a.ts"), []);
});

test("ignores sql.raw with interpolation too — only sql` templates are scanned", () => {
  const source = "const q = sql`select 1`; const r = sql.raw(`select ${n}`);\n";
  assert.deepEqual(lintSqlTemplates(source, "a.ts"), []);
});

test("multi-line flag: the after-interpolation edge on its own line", () => {
  const source = [
    "const q = sql`",
    "  select id from t",
    `  where col like \${"%" + pat}%`,
    "`;",
  ].join("\n");
  const v = lintSqlTemplates(source, "a.ts");
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, "after-interpolation");
  assert.equal(v[0].line, 3);
});

test("a trailing % at the very start of a template is literal text, not an edge", () => {
  const source = "const q = sql`select '%' from t where x = ${v}`;\n";
  assert.deepEqual(lintSqlTemplates(source, "a.ts"), []);
});

test("percent in a quoted string inside an interpolation is not template text", () => {
  const source = "const q = sql`select 1 where fmt = ${'%' + n}`;\n";
  assert.deepEqual(lintSqlTemplates(source, "a.ts"), []);
});

test("templateTextParts splits interpolations out of the literal text", () => {
  const source = "const q = sql`a${b}c`;\n";
  const open = source.indexOf("sql`") + 3; // index of the backtick
  const { parts } = templateTextParts(source, open);
  assert.deepEqual(
    parts.map((p) => source.slice(p.start, p.end)),
    ["a", "c"],
  );
});

test("skipTemplate walks past nested braces, strings and quoted backticks", () => {
  // braces hide inside quoted strings; a backtick hides inside a quoted string —
  // the scanner must find the real closing backtick only.
  const source = "sql`x${ a + '{' }y${ '`' }z`tail";
  const after = skipTemplate(source, source.indexOf("`"));
  assert.equal(source.slice(0, after), "sql`x${ a + '{' }y${ '`' }z`");
  assert.equal(after, source.length - "tail".length);
});

test("the fixed review-rework predicate is clean", () => {
  const source =
    "sql`regexp_replace(${issueWorkProducts.url}, '[#?].*$', '') ~ ('/github.com/' || ${pr.repo} || '/pull/' || ${String(pr.number)} || '(/|$)')`;\n";
  assert.deepEqual(lintSqlTemplates(source, "a.ts"), []);
});

test("formatViolations names file, line and kind", () => {
  const source = "const q = sql`x like ${p}%`;\n";
  const [v] = lintSqlTemplates(source, "pkg/store.ts");
  const line = formatViolations([v])[0];
  assert.match(line, /^pkg\/store\.ts:1:\d+: after-interpolation/);
});

test("collectTsFiles walks a tree, skips node_modules and dot-dirs", (t) => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "sql-lint-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(nodePath.join(dir, "a.ts"), "1");
  fs.mkdirSync(nodePath.join(dir, "sub"));
  fs.writeFileSync(nodePath.join(dir, "sub", "b.ts"), "2");
  fs.mkdirSync(nodePath.join(dir, "node_modules"));
  fs.writeFileSync(nodePath.join(dir, "node_modules", "c.ts"), "3");
  fs.mkdirSync(nodePath.join(dir, ".cache"));
  fs.writeFileSync(nodePath.join(dir, ".cache", "d.ts"), "4");
  fs.writeFileSync(nodePath.join(dir, "e.js"), "5");
  const files = collectTsFiles(dir);
  assert.deepEqual(
    files.map((f) => nodePath.relative(dir, f).split(nodePath.sep).join("/")).sort(),
    ["a.ts", "sub/b.ts"],
  );
});

test("parseArgs accepts --root/--files/--help and rejects unknown flags", () => {
  assert.deepEqual(parseArgs(["--root", "x"]), { root: "x", files: null });
  assert.deepEqual(parseArgs(["--files", "a.ts", "b.ts"]), { root: "server/src", files: ["a.ts", "b.ts"] });
  assert.equal(parseArgs(["--wat"]).bad, true);
});
