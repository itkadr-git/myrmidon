import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareSkipped,
  diffSnapshots,
  expectedSkipped,
  parseCliJson,
} from "./paperclip-migration-live.mjs";
import { verifyMigration } from "./paperclip-migration-verify.mjs";

const snap = (tables, columns = {}) => ({
  tables: Object.fromEntries(Object.entries(tables).map(([k, [rows, hash]]) => [k, { rows, hash }])),
  columns,
});

describe("live migration checks (pure parts)", () => {
  it("detects a modified source: changed content, changed count, appeared and vanished tables", () => {
    const before = snap({ a: [1, "h1"], b: [2, "h2"], c: [0, "h3"] });
    assert.deepEqual(diffSnapshots(before, snap({ a: [1, "h1"], b: [2, "h2"], c: [0, "h3"] })), []);
    const after = snap({ a: [1, "hX"], b: [3, "h2"], d: [0, "h4"] });
    assert.deepEqual(diffSnapshots(before, after), [
      "content changed: a",
      "row count changed: b 2 -> 3",
      "table disappeared: c",
      "table appeared: d",
    ]);
  });

  it("derives the expected skipped data from the two schemas, not from a pattern", () => {
    const source = snap(
      { agents: [2, "x"], mcp_oauth_tokens: [1, "y"], browser_use_runs: [0, "z"], issues: [3, "i"] },
      { agents: ["id", "appearance"], issues: ["id"], mcp_oauth_tokens: ["id"], browser_use_runs: ["id"] },
    );
    const target = snap({ agents: [2, "x"], issues: [3, "i"] }, { agents: ["id"], issues: ["id"] });
    assert.deepEqual(expectedSkipped(source, target), [
      { table: "agents", column: "appearance" },
      { table: "browser_use_runs", rows: 0 },
      { table: "mcp_oauth_tokens", rows: 1 },
    ]);
  });

  it("compares a CLI report with the expected skipped data", () => {
    const expected = [
      { table: "mcp_oauth_tokens", rows: 1 },
      { table: "browser_use_runs", rows: 0 },
      { table: "agents", column: "appearance" },
    ];
    const good = [
      { table: "mcp_oauth_tokens", rows: 1, vendorRelease: "v2026.1012.0", decision: "requires-flag" },
      { table: "browser_use_runs", rows: 0, vendorRelease: "v2026.1005.0", decision: "excluded-empty" },
      { table: "agents", column: "appearance", rows: 2, vendorRelease: "v2026.1001.0", decision: "requires-flag" },
    ];
    assert.deepEqual(compareSkipped(good, expected, { accepted: false }), []);
    assert.deepEqual(
      compareSkipped(good.slice(1), expected, { accepted: false }),
      ["not reported but absent in target: mcp_oauth_tokens"],
    );
    assert.deepEqual(
      compareSkipped([...good, { table: "issues", rows: 3, decision: "accepted" }], expected, { accepted: false }),
      ["reported but present in target or absent in source: issues"],
    );
    const wrongRows = good.map((e) => (e.table === "mcp_oauth_tokens" && !e.column ? { ...e, rows: 5 } : e));
    assert.deepEqual(compareSkipped(wrongRows, expected, { accepted: false }), ["mcp_oauth_tokens: reported rows 5, source has 1"]);
    assert.deepEqual(compareSkipped(good, expected, { accepted: true }), ["mcp_oauth_tokens: decision requires-flag, expected accepted"]);
    assert.deepEqual(compareSkipped(undefined, expected, { accepted: false }), ["report has no skippedSourceData array"]);
  });

  it("parses CLI output that has a banner before the JSON", () => {
    assert.deepEqual(parseCliJson('banner\n{"a":1}\n'), { a: 1 });
    assert.throws(() => parseCliJson("no json"));
  });

  it("requireAll turns a check that could not run into a failure", () => {
    const manifest = { vendorRelease: { tag: "v2026.916.0" }, entityCounts: { companies: 1 } };
    const lax = verifyMigration({ manifest, targetCounts: { companies: 1 } });
    assert.equal(lax.status, "pass");
    const strict = verifyMigration({ manifest, targetCounts: { companies: 1 }, requireAll: true });
    assert.equal(strict.status, "fail");
    assert.ok(strict.errors.some((e) => e.includes("secretReEncryption")));
    assert.ok(strict.errors.some((e) => e.includes("storageFiles")));
  });
});
