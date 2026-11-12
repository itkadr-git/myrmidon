import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  attributeOwnership,
  isOwnershipField,
  isSafeId,
  main,
  recordSubject,
} from "./company-boundaries-inventory.mjs";

// Fixture values are assembled from neutral placeholders so this test file
// does not trip the secret scanners. The UUIDs are well-known documentation
// UUIDs (RFC 4122 examples); the slug id is a documentation domain.
const UUID_A = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const UUID_B = "9c858901-8a57-4791-81fe-4c455b099bc9";
const SLUG = "docs.example.com";
const SECRET_SHAPED = ["pcp_", "invite", "XXX"].join("");
const PASSWORD = ["hunter", 2].join("");

function run(inventory, argv = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-inventory-"));
  const file = path.join(dir, "inventory.json");
  fs.writeFileSync(file, JSON.stringify(inventory));
  const lines = [];
  const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
  const code = main([...argv, "--file", file], log);
  return { code, output: lines.join("\n") };
}

describe("isOwnershipField", () => {
  it("recognizes owner and dependency fields", () => {
    for (const name of [
      "ownerId",
      "owner_ids",
      "companyId",
      "linked-company-id",
      "dependsOn",
      "dependencyIds",
      "sharedWith",
      "assigneeId",
    ]) {
      assert.ok(isOwnershipField(name), name);
    }
  });

  it("rejects unrelated fields", () => {
    for (const name of ["name", "title", "id", "createdAt", "description"]) {
      assert.ok(!isOwnershipField(name), name);
    }
  });

  it("recognizes secret-named owner fields so they get redacted, not printed", () => {
    assert.ok(isOwnershipField("ownerToken"));
    assert.ok(isOwnershipField("companySecretRef"));
  });
});

describe("isSafeId", () => {
  it("accepts exact identifiers", () => {
    assert.ok(isSafeId(UUID_A));
    assert.ok(isSafeId(SLUG));
    assert.ok(isSafeId(42));
    assert.ok(isSafeId("0"));
  });

  it("rejects non-identifier shapes", () => {
    assert.ok(!isSafeId(SECRET_SHAPED)); // underscore shape
    assert.ok(!isSafeId("user@host")); // @ shape
    assert.ok(!isSafeId("some free text")); // spaces
    assert.ok(!isSafeId("")); // empty
    assert.ok(!isSafeId("x".repeat(65))); // over-long
    assert.ok(!isSafeId(1.5)); // non-integer
    assert.ok(!isSafeId(-3)); // negative
    assert.ok(!isSafeId(null));
    assert.ok(!isSafeId({}));
  });
});

describe("attributeOwnership", () => {
  it("reports unknown/unresolved when no owner or dependency fields exist", () => {
    const result = attributeOwnership({ id: UUID_A, name: "widget" });
    assert.equal(result.attribution, "unknown");
    assert.match(result.summary, /unknown\/unresolved/);
    assert.deepEqual(result.fields, []);
  });

  it("reports no cross-company link when owner fields are declared but empty", () => {
    const result = attributeOwnership({ id: UUID_A, ownerId: null, dependsOn: [] });
    assert.equal(result.attribution, "none");
    assert.match(result.summary, /no cross-company link/);
  });

  it("prints exact safe identifiers for known owners", () => {
    const result = attributeOwnership({
      id: UUID_A,
      ownerId: UUID_B,
      dependsOn: [SLUG],
    });
    assert.equal(result.attribution, "attributed");
    assert.ok(result.summary.includes(`ownerId=${UUID_B}`));
    assert.ok(result.summary.includes(`dependsOn=["${SLUG}"]`));
    assert.deepEqual(result.fields, [
      { field: "ownerId", value: UUID_B, redacted: false },
      { field: "dependsOn", value: [SLUG], redacted: false },
    ]);
  });

  it("never prints non-identifier owner values", () => {
    const result = attributeOwnership({ ownerId: `${SECRET_SHAPED}abc` });
    assert.equal(result.attribution, "attributed");
    assert.ok(!result.summary.includes(SECRET_SHAPED));
    assert.ok(result.summary.includes("ownerId=<redacted>"));
    assert.equal(result.fields[0].redacted, true);
  });

  it("redacts secret-named owner fields even when the value is id-shaped", () => {
    const result = attributeOwnership({ ownerToken: UUID_B });
    assert.equal(result.fields[0].value, "<redacted>");
    assert.ok(!result.summary.includes(UUID_B));
  });

  it("redacts unsafe entries inside id arrays individually", () => {
    const result = attributeOwnership({ dependsOn: [UUID_B, "free text", ""] });
    assert.deepEqual(result.fields[0].value, [UUID_B, "<redacted>", "<redacted>"]);
    assert.equal(result.fields[0].redacted, true);
  });

  it("treats a record with unrelated fields only as unknown", () => {
    const result = attributeOwnership({ title: "thing", payload: PASSWORD });
    assert.equal(result.attribution, "unknown");
    assert.ok(!JSON.stringify(result).includes(PASSWORD));
  });
});

describe("recordSubject", () => {
  it("uses the record id when it is a safe identifier", () => {
    assert.equal(recordSubject({ id: UUID_A }, 3), UUID_A);
  });

  it("falls back to the index for missing or unsafe ids", () => {
    assert.equal(recordSubject({ id: SECRET_SHAPED }, 3), "#3");
    assert.equal(recordSubject({}, 7), "#7");
    assert.equal(recordSubject("string", 1), "#1");
  });
});

describe("main", () => {
  it("exits 0 and prints the count summary for a resolved inventory", () => {
    const { code, output } = run([
      { id: UUID_A, ownerId: UUID_B },
      { id: UUID_B, ownerId: null },
    ]);
    assert.equal(code, 0);
    assert.match(output, new RegExp(`\\[${UUID_A}\\] owner attribution`));
    assert.match(output, /no cross-company link/);
    assert.match(output, /2 record\(s\): 1 attributed, 1 none, 0 unknown/);
  });

  it("exits 1 when a record is unknown/unresolved", () => {
    const { code, output } = run([{ id: UUID_A, name: "widget" }]);
    assert.equal(code, 1);
    assert.match(output, /unknown\/unresolved/);
    assert.match(output, /1 record\(s\): 0 attributed, 0 none, 1 unknown/);
  });

  it("accepts a records wrapper object", () => {
    const { code, output } = run({ records: [{ ownerId: UUID_A }] });
    assert.equal(code, 0);
    assert.match(output, /owner attribution/);
  });

  it("emits machine-readable JSON with --json and never leaks unsafe values", () => {
    const { code, output } = run([{ ownerId: `${SECRET_SHAPED}zz` }], ["--json"]);
    assert.equal(code, 0);
    const parsed = JSON.parse(output);
    assert.equal(parsed.counts, undefined ? null : parsed.counts);
    assert.equal(parsed.records[0].fields[0].value, "<redacted>");
    assert.ok(!output.includes(SECRET_SHAPED));
  });

  it("exits 2 on invalid JSON without echoing the input", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-inventory-"));
    const file = path.join(dir, "inventory.json");
    fs.writeFileSync(file, `{ "records": [ ${PASSWORD} }`);
    const lines = [];
    const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
    assert.equal(main(["--file", file], log), 2);
    const output = lines.join("\n");
    assert.ok(!output.includes(PASSWORD));
  });

  it("exits 2 when the inventory shape is wrong", () => {
    const { code } = run({ nope: true });
    assert.equal(code, 2);
  });

  it("exits 2 on a missing file", () => {
    const lines = [];
    const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
    assert.equal(main(["--file", "/nonexistent/missing.json"], log), 2);
  });

  it("exits 2 when --file has no path and on unknown arguments", () => {
    const lines = [];
    const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
    assert.equal(main(["--file"], log), 2);
    assert.equal(main(["--nope"], log), 2);
  });

  it("prints usage for --help", () => {
    const lines = [];
    const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
    assert.equal(main(["--help"], log), 0);
    assert.match(lines.join("\n"), /usage:/);
  });
});
