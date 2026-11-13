// OPE-12874: docs-only consistency test for the company-boundaries inventory
// coverage report (doc/plans/2026-11-12-company-boundaries-inventory.md).
//
// The report's "Покрытие по секциям инвентаря" table must match the recorded
// probe-results fixture exactly: same sections, same endpoint/export source,
// same coverage state. This test imports no probe code — it parses the report
// markdown and cross-checks it against
// scripts/myrmidon/fixtures/company-boundaries-inventory-coverage.json.
//
// Named company-boundaries-inventory-coverage.test.mjs on purpose: the
// behavioral probe test (company-boundaries-inventory.test.mjs) lives in the
// probe-script branch; this file is the docs/fixture evidence for OPE-12874.
//
// Read-only: no network, no filesystem writes, no board access.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..", "..");
const REPORT_PATH = path.join(REPO_ROOT, "doc", "plans", "2026-11-12-company-boundaries-inventory.md");
const FIXTURE_PATH = path.join(here, "fixtures", "company-boundaries-inventory-coverage.json");

const report = fs.readFileSync(REPORT_PATH, "utf8");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

/** Parse the coverage table rows out of the report markdown. */
function parseCoverageTable(md) {
  const lines = md.split("\n");
  const start = lines.findIndex((line) => line.startsWith("## Покрытие по секциям инвентаря"));
  assert.notEqual(start, -1, "coverage section heading missing from report");
  const tableLines = [];
  let inTable = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("| ")) {
      tableLines.push(line);
      inTable = true;
    } else if (inTable && line.trim() === "") {
      break;
    } else if (inTable && !line.startsWith("|")) {
      break;
    }
  }
  const rawRows = tableLines.filter((line) => !/^\|[\s\-:|]+\|$/.test(line));
  assert.ok(rawRows.length >= 2, "coverage table missing or empty");
  const rows = rawRows.slice(1).map((line) => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim().replaceAll("`", ""));
    assert.equal(cells.length, 4, `coverage row must have 4 cells: ${line}`);
    return { id: cells[0], source: cells[1], state: cells[2], evidence: cells[3] };
  });
  return rows;
}

test("report coverage table exists and fixture lists the same sections in the same order", () => {
  const rows = parseCoverageTable(report);
  assert.deepEqual(
    rows.map((row) => row.id),
    fixture.sections.map((section) => section.id),
    "report table and fixture section lists diverge",
  );
});

test("every section has an endpoint/export source and a valid coverage state", () => {
  const rows = parseCoverageTable(report);
  const states = new Set(fixture.states);
  assert.deepEqual([...states].sort(), ["covered", "partial", "unavailable"]);
  for (const row of rows) {
    assert.ok(row.source.length > 0, `section ${row.id}: missing source in report`);
    assert.ok(row.source.includes("/"), `section ${row.id}: source is not an endpoint/export reference`);
    assert.ok(states.has(row.state), `section ${row.id}: invalid state '${row.state}' in report`);
    const section = fixture.sections.find((entry) => entry.id === row.id);
    const fixtureSource = section.source.replaceAll("`", "");
    assert.equal(row.source, fixtureSource, `section ${row.id}: source mismatch report vs fixture`);
    assert.equal(row.state, section.state, `section ${row.id}: state mismatch report vs fixture`);
  }
});

test("no unavailable section is declared covered anywhere in the report", () => {
  const rows = parseCoverageTable(report);
  const unavailable = new Set(rows.filter((row) => row.state === "unavailable").map((row) => row.id));
  assert.ok(unavailable.size > 0, "fixture must record at least one unavailable section");
  // The summary table ("Доступность") may name 403/404 surfaces, but the
  // coverage table is authoritative; assert none of its unavailable rows is
  // re-stated as covered in the owner-attribution block.
  const ownerBlock = report.split("### Owner attribution")[1] ?? "";
  for (const id of unavailable) {
    const coveredClaim = new RegExp(`${id}[^\\n]*(covered|покрыт)`, "i");
    assert.ok(!coveredClaim.test(ownerBlock), `unavailable section ${id} is claimed covered in owner block`);
  }
});

test("owner attribution unknowns are stated explicitly in the report", () => {
  const ownerBlock = report.split("### Owner attribution")[1] ?? "";
  for (const expected of fixture.ownerAttribution.unknowns) {
    const marker = expected.split(":")[0];
    assert.ok(ownerBlock.includes(marker), `owner-attribution block must mention '${marker}'`);
  }
  assert.ok(ownerBlock.includes("unknown"), "owner-attribution block must use the explicit 'unknown' marker");
  assert.ok(
    report.includes("metadata.forkedByAgentId"),
    "report must state the explicit owner-field attribution rule",
  );
});

test("fixture schema and measured date are recorded", () => {
  assert.equal(fixture.schema, "company-boundaries-inventory-coverage/v1");
  assert.match(fixture.measuredAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(
    fixture.sections.length,
    parseCoverageTable(report).length,
    "fixture/report section counts diverge",
  );
});
