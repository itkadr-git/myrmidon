import test from "node:test";
import assert from "node:assert/strict";
import { collectInventory, INVENTORY_SECTIONS, renderInventory, sectionForPath } from "./company-boundaries-inventory.mjs";

function makeResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => (body === undefined ? {} : body),
  };
}

test("success with data rows marks covered with counts", async () => {
  let calls = 0;
  const report = await collectInventory({ fetch: async () => { calls += 1; return makeResponse(200, { items: [{ id: "a" }] }); } });
  assert.equal(report.summary.total, INVENTORY_SECTIONS.length);
  assert.equal(report.summary.covered, INVENTORY_SECTIONS.length);
  assert.equal(report.summary.counts.data, INVENTORY_SECTIONS.length);
  for (const section of report.sections) {
    assert.equal(section.state, "data");
    assert.equal(section.count, 1);
    assert.deepEqual(section.missingAttribution, sectionForPath(`/${section.key}`).attribution);
  }
  assert.equal(calls, INVENTORY_SECTIONS.length);
});

test("success with an empty payload is covered and distinct from denied", async () => {
  const report = await collectInventory({ fetch: async () => makeResponse(200, []) });
  assert.equal(report.summary.counts.empty, INVENTORY_SECTIONS.length);
  assert.equal(report.summary.covered, INVENTORY_SECTIONS.length);
});

test("403 and 404 map to denied and not-found without coverage", async () => {
  let index = 0;
  const report = await collectInventory({ fetch: async () => (index++ % 2 === 0 ? makeResponse(403) : makeResponse(404)) });
  assert.equal(report.summary.counts.denied, 5);
  assert.equal(report.summary.counts["not-found"], 5);
  assert.equal(report.summary.covered, 0);
  for (const section of report.sections) {
    assert.equal(section.covered, false);
    assert.deepEqual(section.missingAttribution, []);
  }
});

test("malformed or ignored payloads are not covered", async () => {
  let index = 0;
  const report = await collectInventory({
    fetch: async () => {
      index += 1;
      if (index === 1) return makeResponse(200, { unexpected: true });
      if (index === 2) return makeResponse(500);
      throw new Error("transport failure");
    },
  });
  assert.equal(report.sections[0].state, "error");
  assert.equal(report.sections[1].state, "error");
  assert.equal(report.sections[2].state, "error");
  assert.equal(report.summary.counts.error, INVENTORY_SECTIONS.length);
  assert.equal(report.summary.covered, 0);
});

test("summary is repeatable for the same transport", async () => {
  const fetch = async (path) => (path === "/issues" ? makeResponse(200, { items: [{}] }) : makeResponse(403));
  const first = await collectInventory({ fetch });
  const second = await collectInventory({ fetch });
  assert.deepEqual(first.summary, second.summary);
  assert.deepEqual(first.sections, second.sections);
  assert.equal(JSON.parse(renderInventory(first)).summary.total, INVENTORY_SECTIONS.length);
});

test("unknown sections are absent from the registry and cannot be covered", () => {
  assert.equal(sectionForPath("/not-a-section"), undefined);
  assert.ok(INVENTORY_SECTIONS.every((section) => sectionForPath(section.path)));
});
