import assert from "node:assert/strict";
import test from "node:test";
import { buildReconciliationReport } from "./report.ts";

const issueId = "123e4567-e89b-42d3-a456-426614174000";

function inventoryEntry(overrides = {}) {
  return {
    id: issueId,
    identifier: "OPE-1",
    status: "blocked",
    blockerMetadata: null,
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    class: "dependency",
    evidence: ["Waiting on OPE-2."],
    proposedOwner: "agent-1",
    ...overrides,
  };
}

function countsByClass(rows) {
  return Object.fromEntries(
    ["dependency", "recovery", "human_decision", "external_wait", "resource", "terminal", "unknown"]
      .map((blockClass) => [blockClass, rows.filter((row) => row.class === blockClass).length]),
  );
}

function sumTotals(totals) {
  return Object.values(totals).reduce((sum, val) => sum + val, 0);
}

test("buildReconciliationReport accounts for every inventoried issue exactly once without loss", () => {
  const inventory = [
    inventoryEntry(),
    inventoryEntry({ id: "123e4567-e89b-42d3-a456-426614174001", identifier: "OPE-2" }),
    inventoryEntry({ id: "123e4567-e89b-42d3-a456-426614174002", identifier: "OPE-3" }),
  ];
  const results = [
    { issueId: inventory[0].id, ...result({ class: "dependency" }) },
    { issueId: inventory[1].id, ...result({ class: "terminal" }) },
    { issueId: inventory[2].id, ...result({ class: "unknown" }) },
  ];

  const report = buildReconciliationReport(inventory, results);

  assert.equal(report.rows.length, 3);
  assert.equal(report.lost.length, 0);
  assert.deepEqual(report.totals, countsByClass(report.rows));
  // Invariant without loss: sum(totals) === inventory.length
  assert.equal(sumTotals(report.totals), inventory.length);
});

test("buildReconciliationReport invariant with losses: sum(totals) + unique lost issueIds === inventory.length", () => {
  const inventory = [
    inventoryEntry(),
    inventoryEntry({ id: "123e4567-e89b-42d3-a456-426614174001", identifier: "OPE-2" }),
    inventoryEntry({ id: "123e4567-e89b-42d3-a456-426614174002", identifier: "OPE-3" }),
  ];
  const results = [
    { issueId: inventory[0].id, ...result({ class: "dependency" }) },
    // inventory[1] has no result (missing_result)
    // inventory[2] has invalid result (invalid_result)
    { issueId: inventory[2].id, ...result({ class: "invalid_class" }) },
  ];

  const report = buildReconciliationReport(inventory, results);

  assert.equal(report.rows.length, 1);
  assert.deepEqual(report.totals, countsByClass(report.rows));

  // Extract unique lost issueIds that belong to inventory
  const inventoryIds = new Set(inventory.map((e) => e.id));
  const uniqueLostInventoryIds = new Set(
    report.lost.filter((l) => inventoryIds.has(l.issueId)).map((l) => l.issueId),
  );

  // Invariant with loss: sum(totals) + unique lost inventory === inventory.length
  assert.equal(sumTotals(report.totals) + uniqueLostInventoryIds.size, inventory.length);
  assert.equal(sumTotals(report.totals) + uniqueLostInventoryIds.size, 3);
});

test("includes one explicit lost entry per input when a result or inventory row is unmatched", () => {
  const report = buildReconciliationReport([], [{ issueId, ...result() }]);

  assert.ok(report.lost.some((l) => l.issueId === issueId && l.reason === "missing_inventory"));
  assert.equal(report.rows.length, 0);
});

test("covers duplicate_result when multiple results exist for single inventory entry", () => {
  const inventory = [inventoryEntry()];
  const results = [
    { issueId, ...result({ class: "dependency" }) },
    { issueId, ...result({ class: "recovery" }) },
  ];

  const report = buildReconciliationReport(inventory, results);

  assert.equal(report.rows.length, 0);
  assert.equal(report.lost.length, 1);
  assert.equal(report.lost[0].issueId, issueId);
  assert.equal(report.lost[0].reason, "duplicate_result");
  assert.equal(report.lost[0].identifier, "OPE-1");

  // Invariant with loss:
  const uniqueLost = new Set(report.lost.map((l) => l.issueId));
  assert.equal(sumTotals(report.totals) + uniqueLost.size, inventory.length);
});

test("covers invalid_result: non-existent class, missing proposedOwner for non-unknown, evidence > 2000", () => {
  const inv1 = inventoryEntry({ id: "123e4567-e89b-42d3-a456-426614174001", identifier: "OPE-INV-1" });
  const inv2 = inventoryEntry({ id: "123e4567-e89b-42d3-a456-426614174002", identifier: "OPE-INV-2" });
  const inv3 = inventoryEntry({ id: "123e4567-e89b-42d3-a456-426614174003", identifier: "OPE-INV-3" });

  const inventory = [inv1, inv2, inv3];
  const results = [
    // 1. Invalid class
    { issueId: inv1.id, ...result({ class: "some_unrecognized_class" }) },
    // 2. Missing proposedOwner for non-unknown class (dependency requires proposedOwner)
    { issueId: inv2.id, class: "dependency", evidence: ["Valid evidence"], proposedOwner: undefined },
    // 3. Evidence > 2000 chars
    { issueId: inv3.id, ...result({ class: "dependency", evidence: ["x".repeat(2001)] }) },
  ];

  const report = buildReconciliationReport(inventory, results);

  assert.equal(report.rows.length, 0);
  assert.equal(report.lost.length, 3);
  assert.ok(report.lost.some((l) => l.issueId === inv1.id && l.reason === "invalid_result" && l.identifier === "OPE-INV-1"));
  assert.ok(report.lost.some((l) => l.issueId === inv2.id && l.reason === "invalid_result" && l.identifier === "OPE-INV-2"));
  assert.ok(report.lost.some((l) => l.issueId === inv3.id && l.reason === "invalid_result" && l.identifier === "OPE-INV-3"));

  const uniqueLost = new Set(report.lost.map((l) => l.issueId));
  assert.equal(sumTotals(report.totals) + uniqueLost.size, inventory.length);
});

test("separates unknown classifications from classified rows", () => {
  const report = buildReconciliationReport([inventoryEntry()], [
    { issueId, class: "unknown", evidence: ["Evidence is ambiguous."] },
  ]);

  assert.equal(report.rows[0].class, "unknown");
  assert.deepEqual(report.unknown, [report.rows[0]]);
  assert.equal(report.totals.unknown, 1);
  assert.equal(report.totals.dependency, 0);
  assert.equal(sumTotals(report.totals), 1);
});

test("reports duplicate import keys without dropping inventory rows", () => {
  const duplicateId = "123e4567-e89b-42d3-a456-426614174001";
  const inventory = [inventoryEntry(), inventoryEntry({ id: duplicateId, identifier: "OPE-2" })];
  const repeatedKey = `legacy-blocked:v1:${issueId}`;
  const report = buildReconciliationReport(inventory, [
    { issueId, ...result({ importKey: repeatedKey }) },
    { issueId: duplicateId, ...result({ importKey: repeatedKey }) },
  ]);

  assert.equal(report.rows.length, 2);
  assert.deepEqual(report.duplicates, [{ importKey: repeatedKey, issueIds: [issueId, duplicateId] }]);
  assert.equal(sumTotals(report.totals), inventory.length);
});

test("preserves per-entry accounting for duplicate inventory IDs as lost records", () => {
  const inventory = [
    inventoryEntry({ identifier: "OPE-1" }),
    inventoryEntry({ identifier: "OPE-1-duplicate" }),
  ];
  const results = [{ issueId, ...result() }];

  const report = buildReconciliationReport(inventory, results);

  assert.equal(report.rows.length, 0);
  const lostEntries = report.lost.filter((l) => l.issueId === issueId && l.reason === "duplicate_inventory");
  assert.equal(lostEntries.length, 2);
  assert.deepEqual(lostEntries.map((l) => l.identifier), ["OPE-1", "OPE-1-duplicate"]);

  const uniqueLost = new Set(report.lost.map((l) => l.issueId));
  assert.equal(sumTotals(report.totals) + uniqueLost.size, 1); // 1 unique ID in inventory
});

test("renders Markdown and JSON from the same complete report data", () => {
  const report = buildReconciliationReport([inventoryEntry()], [{ issueId, ...result() }]);

  assert.ok(report.markdown.includes("| OPE-1 | blocked | dependency |"));
  assert.deepEqual(JSON.parse(report.json), {
    rows: report.rows,
    totals: report.totals,
    unknown: report.unknown,
    duplicates: report.duplicates,
    lost: report.lost,
  });
});
