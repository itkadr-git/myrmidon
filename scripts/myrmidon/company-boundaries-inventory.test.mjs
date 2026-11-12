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
  const report = await collectInventory({
    fetch: async (path) => {
      calls += 1;
      const section = sectionForPath(path);
      const row = Object.fromEntries(section.attribution.map((field) => [field, `present-${field}`]));
      return makeResponse(200, { items: [{ id: "a", ...row }] });
    },
  });
  assert.equal(report.summary.total, INVENTORY_SECTIONS.length);
  assert.equal(report.summary.covered, INVENTORY_SECTIONS.length);
  assert.equal(report.summary.counts.data, INVENTORY_SECTIONS.length);
  for (const section of report.sections) {
    assert.equal(section.state, "data");
    assert.equal(section.count, 1);
    assert.deepEqual(section.missingAttribution, []);
  }
  assert.equal(calls, INVENTORY_SECTIONS.length);
});

test("missing attribution fields are computed from observed rows", async () => {
  const report = await collectInventory({
    fetch: async (path) => {
      if (path === "/agents") return makeResponse(200, { items: [{ id: "a1", ownerCompanyId: "c1" }, { id: "a2" }] });
      if (path === "/issues") return makeResponse(200, { items: [{ id: "i1", ownerCompanyId: "c1", dependency: "dep-1" }] });
      if (path === "/projects-documents") return makeResponse(200, { items: [{ id: "p1", ownerCompanyId: null }] });
      if (path === "/skills-policies") return makeResponse(200, { items: [{ id: "s1", dependency: "d1" }] });
      return makeResponse(200, []);
    },
  });
  const byKey = Object.fromEntries(report.sections.map((section) => [section.key, section]));
  assert.deepEqual(byKey.agents.missingAttribution, ["ownerCompanyId"]);
  assert.deepEqual(byKey.issues.missingAttribution, []);
  assert.deepEqual(byKey["projects-documents"].missingAttribution, ["ownerCompanyId"]);
  assert.deepEqual(byKey["skills-policies"].missingAttribution, ["ownerCompanyId"]);
  assert.deepEqual(byKey["budgets-costs"].missingAttribution, ["ownerCompanyId"]);
  const rendered = renderInventory(report);
  assert.ok(!rendered.includes("c1"));
  assert.ok(!rendered.includes("dep-1"));
  assert.ok(!rendered.includes("a1"));
});

test("success with an empty payload is covered and distinct from denied", async () => {
  const report = await collectInventory({ fetch: async () => makeResponse(200, []) });
  assert.equal(report.summary.counts.empty, INVENTORY_SECTIONS.length);
  assert.equal(report.summary.covered, INVENTORY_SECTIONS.length);
  for (const section of report.sections) {
    assert.deepEqual(section.missingAttribution, sectionForPath(`/${section.key}`).attribution);
  }
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
