#!/usr/bin/env node
// Live checks for the Paperclip -> Myrmidon migration matrix (CI).
//
// Everything here is derived from real PostgreSQL databases (psql), never from
// values handed over by the workflow as claims:
//   snapshot         per-table row count + content hash + column list of a database
//   same-snapshot    two snapshots are identical (source was not modified)
//   check-skipped    `skippedSourceData` of a CLI report equals what information_schema
//                    says the source has and the target lacks
//   verify-target    counts, ids, relations, spot checks, secrets (old key rejected,
//                    new key accepted) and copied files, read back from the target
//   verify-rollback  target holds no tables and none of the copied files after --rollback
//   expect-failure   a CLI run that must have been refused left the target untouched
//
// Exit codes: 0 pass, 1 mismatch, 2 usage / prerequisites missing (skipped is not green).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyMigration } from "./paperclip-migration-verify.mjs";

export const EXIT_OK = 0;
export const EXIT_MISMATCH = 1;
export const EXIT_USAGE = 2;

const IDENT = /^[A-Za-z0-9_]+$/;

export function psql(url, sql) {
  return execFileSync("psql", [url, "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-F", "\t", "-c", sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function rows(text) {
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split("\t"));
}

/** Row count + content hash of every public base table, and the column list of each. */
export function takeSnapshot(url) {
  const tableSql = `
    select t.table_name,
           (xpath('/row/c/text()', x.v))[1]::text,
           (xpath('/row/h/text()', x.v))[1]::text
    from information_schema.tables t
    cross join lateral (
      select query_to_xml(
        format('select count(*) as c, md5(coalesce(string_agg(r::text, %L order by r::text), %L)) as h from public.%I r', '|', '', t.table_name),
        false, true, '') as v
    ) x
    where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
    order by 1`;
  const tables = {};
  for (const [name, count, hash] of rows(psql(url, tableSql))) {
    if (!IDENT.test(name)) throw new Error(`Unexpected table name: ${name}`);
    tables[name] = { rows: Number(count), hash };
  }
  const columns = {};
  const colSql = `select table_name, column_name from information_schema.columns where table_schema = 'public' order by 1, 2`;
  for (const [table, column] of rows(psql(url, colSql))) {
    (columns[table] ??= []).push(column);
  }
  return { tables, columns };
}

/** Differences between two snapshots; an empty list means identical. */
export function diffSnapshots(before, after) {
  const problems = [];
  const names = new Set([...Object.keys(before.tables), ...Object.keys(after.tables)]);
  for (const name of [...names].sort()) {
    const a = before.tables[name];
    const b = after.tables[name];
    if (!a) problems.push(`table appeared: ${name}`);
    else if (!b) problems.push(`table disappeared: ${name}`);
    else if (a.rows !== b.rows) problems.push(`row count changed: ${name} ${a.rows} -> ${b.rows}`);
    else if (a.hash !== b.hash) problems.push(`content changed: ${name}`);
  }
  return problems;
}

/**
 * What the source has and the target lacks, from the two databases' own
 * schemas: whole tables (with their row count) and columns of shared tables.
 */
export function expectedSkipped(source, target) {
  const out = [];
  for (const table of Object.keys(source.tables).sort()) {
    if (!target.tables[table]) {
      out.push({ table, rows: source.tables[table].rows });
      continue;
    }
    const have = new Set(target.columns[table] ?? []);
    for (const column of source.columns[table] ?? []) {
      if (!have.has(column)) out.push({ table, column });
    }
  }
  return out;
}

const keyOf = (e) => (e.column ? `${e.table}.${e.column}` : e.table);

/**
 * Compares the `skippedSourceData` of a CLI report with `expectedSkipped`.
 * `accepted` is whether the run carried --accept-vendor-only-data.
 */
export function compareSkipped(reported, expected, { accepted }) {
  const problems = [];
  if (!Array.isArray(reported)) return ["report has no skippedSourceData array"];
  const got = new Map(reported.map((e) => [keyOf(e), e]));
  const want = new Map(expected.map((e) => [keyOf(e), e]));
  for (const k of want.keys()) if (!got.has(k)) problems.push(`not reported but absent in target: ${k}`);
  for (const k of got.keys()) if (!want.has(k)) problems.push(`reported but present in target or absent in source: ${k}`);
  for (const [k, w] of want) {
    const g = got.get(k);
    if (!g) continue;
    if (w.column) {
      if (!["accepted", "requires-flag", "excluded-empty"].includes(g.decision)) problems.push(`${k}: unexpected decision ${g.decision}`);
      continue;
    }
    if (g.rows !== w.rows) problems.push(`${k}: reported rows ${g.rows}, source has ${w.rows}`);
    const decision = w.rows > 0 ? (accepted ? "accepted" : "requires-flag") : "excluded-empty";
    if (g.decision !== decision) problems.push(`${k}: decision ${g.decision}, expected ${decision}`);
  }
  return problems;
}

/** The CLI prints one JSON document; tolerate runner banners before it. */
export function parseCliJson(text) {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("no JSON in CLI output");
  return JSON.parse(text.slice(start));
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function readTargetState(url, manifest, skippedTables) {
  const sc = manifest.spotChecks ?? {};
  const counts = {};
  for (const table of Object.keys(manifest.entityCounts ?? {})) {
    if (!IDENT.test(table)) throw new Error(`Unexpected table name in manifest: ${table}`);
    counts[table] = Number(psql(url, `select count(*) from public.${table}`).trim());
  }
  const targetSecrets = {};
  const secretSql = `select secret_id, material::text from public.company_secret_versions order by secret_id, version`;
  for (const [secretId, material] of rows(psql(url, secretSql))) {
    const check = [sc.secret, sc.secret2].find((s) => s?.id === secretId);
    targetSecrets[secretId] = { material: JSON.parse(material), expectedSha256: check?.expectedSha256 };
  }
  const spot = (table, id) => {
    if (!IDENT.test(table)) throw new Error(`Unexpected table: ${table}`);
    const out = psql(url, `select to_jsonb(t)::text from public.${table} t where id = ${sqlLiteral(id)}`).trim();
    return out ? JSON.parse(out) : null;
  };
  return { counts, targetSecrets, spot, skippedTables };
}

function spotProblems(spot, manifest) {
  const sc = manifest.spotChecks ?? {};
  const problems = [];
  const expectEq = (label, row, field, want) => {
    if (!row) problems.push(`${label}: row missing in target`);
    else if (row[field] !== want) problems.push(`${label}: ${field} is ${JSON.stringify(row[field])}, expected ${JSON.stringify(want)}`);
  };
  if (sc.company) {
    const row = spot("companies", sc.company.id);
    expectEq("company", row, "name", sc.company.name);
    expectEq("company", row, "issue_prefix", sc.company.issuePrefix);
  }
  if (sc.project) expectEq("project", spot("projects", sc.project.id), "name", sc.project.name);
  if (sc.issue) {
    const row = spot("issues", sc.issue.id);
    expectEq("issue", row, "identifier", sc.issue.identifier);
    expectEq("issue", row, "title", sc.issue.title);
  }
  if (sc.agent) {
    const row = spot("agents", sc.agent.id);
    expectEq("agent", row, "name", sc.agent.name);
    expectEq("agent", row, "role", sc.agent.role);
  }
  return problems;
}

/** Full check of a migrated target against the source snapshot, manifest and files. */
export function verifyTarget({ manifest, sourceSnapshot, sourceUrl, targetUrl, targetDir, sourceKey, targetKey }) {
  const problems = [];
  const targetSnapshot = takeSnapshot(targetUrl);

  // Every source table the target has: same rows (hash over whole rows is not
  // comparable once the target has extra columns, so compare the id sets).
  const skipped = new Set(expectedSkipped(sourceSnapshot, targetSnapshot).filter((e) => !e.column).map((e) => e.table));
  for (const [table, src] of Object.entries(sourceSnapshot.tables)) {
    if (skipped.has(table)) continue;
    const tgt = targetSnapshot.tables[table];
    if (!tgt) continue;
    if (tgt.rows !== src.rows) problems.push(`row count differs in ${table}: source ${src.rows}, target ${tgt.rows}`);
  }
  for (const table of Object.keys(sourceSnapshot.tables)) {
    if (skipped.has(table) || !(sourceSnapshot.columns[table] ?? []).includes("id")) continue;
    if (!IDENT.test(table)) continue;
    const idHash = (url) =>
      psql(url, `select md5(coalesce(string_agg(id::text, ',' order by id::text), '')) from public."${table}"`).trim();
    if (idHash(sourceUrl) !== idHash(targetUrl)) problems.push(`id set differs in ${table}`);
  }

  const state = readTargetState(targetUrl, manifest, skipped);
  problems.push(...spotProblems(state.spot, manifest));

  // Relations: no dangling reference from issues to projects.
  const dangling = Number(
    psql(
      targetUrl,
      `select count(*) from public.issues i left join public.projects p on p.id = i.project_id where i.project_id is not null and p.id is null`,
    ).trim(),
  );
  if (dangling !== 0) problems.push(`${dangling} issue(s) reference a project missing in target`);

  // Every table the manifest lists must be non-empty on both sides.
  const report = verifyMigration({
    manifest,
    targetCounts: state.counts,
    targetStorageDir: targetDir,
    targetSecrets: state.targetSecrets,
    sourceKey,
    targetKey,
    requireAll: true,
  });
  if (report.status !== "pass") problems.push(...report.errors);
  return { problems, report, targetSnapshot };
}

/** After --rollback the target must hold no tables and none of the copied files. */
export function verifyRolledBack({ manifest, targetUrl, targetDir }) {
  const problems = [];
  const left = Object.keys(takeSnapshot(targetUrl).tables);
  if (left.length > 0) problems.push(`target still has ${left.length} table(s) after rollback: ${left.slice(0, 5).join(", ")}`);
  for (const file of manifest.files ?? []) {
    const p = path.resolve(targetDir, file.relativePath || file.objectKey);
    if (fs.existsSync(p)) problems.push(`copied file still present after rollback: ${file.objectKey}`);
  }
  return problems;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else out[key] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

function need(args, ...names) {
  const missing = names.filter((n) => !args[n] || args[n] === true);
  if (missing.length) {
    process.stderr.write(`Missing argument(s): ${missing.map((n) => `--${n}`).join(", ")}\n`);
    process.exit(EXIT_USAGE);
  }
}

function finish(label, problems) {
  if (problems.length === 0) {
    process.stdout.write(`${label}: OK\n`);
    return EXIT_OK;
  }
  process.stderr.write(`${label}: FAILED\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
  return EXIT_MISMATCH;
}

export function runCli(argv = process.argv.slice(2)) {
  const [cmd] = argv;
  const args = parseArgs(argv.slice(1));
  switch (cmd) {
    case "snapshot": {
      need(args, "url", "out");
      fs.writeFileSync(args.out, `${JSON.stringify(takeSnapshot(args.url), null, 1)}\n`);
      return EXIT_OK;
    }
    case "same-snapshot": {
      need(args, "before", "url", "label");
      const before = JSON.parse(fs.readFileSync(args.before, "utf8"));
      return finish(`source unchanged (${args.label})`, diffSnapshots(before, takeSnapshot(args.url)));
    }
    case "check-skipped": {
      need(args, "source-snapshot", "target-url", "report", "label");
      const source = JSON.parse(fs.readFileSync(args["source-snapshot"], "utf8"));
      const report = parseCliJson(fs.readFileSync(args.report, "utf8"));
      const expected = expectedSkipped(source, takeSnapshot(args["target-url"]));
      return finish(`skippedSourceData (${args.label})`, compareSkipped(report.skippedSourceData, expected, { accepted: args.accepted === "true" }));
    }
    case "compare-reports": {
      need(args, "a", "b");
      const a = parseCliJson(fs.readFileSync(args.a, "utf8"));
      const b = parseCliJson(fs.readFileSync(args.b, "utf8"));
      const key = (r) => JSON.stringify({ inventory: r.inventory, skipped: r.skippedSourceData, release: r.source?.vendorRelease });
      return finish("dry-run url vs dump", key(a) === key(b) ? [] : ["dry-run from URL and from pg_dump differ in inventory, skippedSourceData or release"]);
    }
    case "dry-run-release": {
      need(args, "report", "manifest");
      const report = parseCliJson(fs.readFileSync(args.report, "utf8"));
      const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
      const got = report.source?.vendorRelease;
      const want = manifest.vendorRelease?.tag;
      const sameBase = ["v2026.916.0", "v2026.916.1"];
      const ok = got === want || (sameBase.includes(got) && sameBase.includes(want));
      return finish("dry-run vendor release", report.mode === "dry-run" && report.writesPerformed === false && ok ? [] : [`mode=${report.mode} writes=${report.writesPerformed} release=${got} expected=${want}`]);
    }
    case "verify-target": {
      need(args, "manifest", "source-snapshot", "target-url", "target-dir", "source-url", "label");
      const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
      const { problems, report } = verifyTarget({
        manifest,
        sourceUrl: args["source-url"],
        sourceSnapshot: JSON.parse(fs.readFileSync(args["source-snapshot"], "utf8")),
        targetUrl: args["target-url"],
        targetDir: args["target-dir"],
        sourceKey: manifest.keys?.sourceMasterKeyHex,
        targetKey: manifest.keys?.targetMasterKeyHex,
      });
      if (args["report-json"]) fs.writeFileSync(args["report-json"], `${JSON.stringify({ problems, report }, null, 2)}\n`);
      return finish(`target content (${args.label})`, problems);
    }
    case "verify-rollback": {
      need(args, "manifest", "target-url", "target-dir", "label");
      const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
      return finish(`rollback (${args.label})`, verifyRolledBack({ manifest, targetUrl: args["target-url"], targetDir: args["target-dir"] }));
    }
    case "verify-refused": {
      need(args, "target-url", "label");
      const left = Object.keys(takeSnapshot(args["target-url"]).tables);
      return finish(`refused run left target empty (${args.label})`, left.length ? [`target has ${left.length} table(s)`] : []);
    }
    default:
      process.stderr.write(`Unknown command: ${cmd ?? "(none)"}\n`);
      return EXIT_USAGE;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  process.exit(runCli());
}
