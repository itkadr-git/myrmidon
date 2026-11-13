import test from "node:test";
import assert from "node:assert/strict";
import {
  collectInventory,
  formatOwnerAttribution,
  INVENTORY_METHOD,
  INVENTORY_SECTIONS,
  inventoryReportHash,
  isUnresolvedAttribution,
  normalizeInventoryReport,
  OWNER_ATTRIBUTION_REASONS,
  renderInventory,
  sectionForPath,
} from "./company-boundaries-inventory.mjs";

/** Method-counting, path-recording mock transport. Rejects any non-GET method up front. */
function makeGetOnlyTransport(respond) {
  const methods = [];
  const seenPaths = [];
  return {
    methods,
    seenPaths,
    request({ method, path }) {
      methods.push(method);
      seenPaths.push(path);
      if (method !== INVENTORY_METHOD) {
        return Promise.reject(new Error(`unexpected non-GET method: ${method} ${path}`));
      }
      return Promise.resolve(respond({ method, path, calls: methods.length }));
    },
  };
}

/** Stable fixture: a deterministic per-section scripted GET response table. */
function stableFixtureResponse(path) {
  const fixtures = {
    "/agents": { status: 200, body: { items: [{ id: "agent-1", ownerCompanyId: "c1" }] } },
    "/issues": { status: 200, body: [{ id: "issue-1", ownerCompanyId: "c1" }] },
    "/projects-documents": { status: 200, body: [] },
    "/skills-policies": { status: 403 },
    "/secrets-bindings": { status: 404 },
    "/connections-tools": { status: 200, body: { items: [{ id: "conn-1" }] } },
    "/budgets-costs": { status: 200, body: { items: [] } },
    "/memory-knowledge-sessions": { status: 200, body: { unexpectedShape: true } },
    "/chat-exchange-wake": { status: 503 },
    "/audit-approvals": { status: 200, body: { items: [{ id: "audit-1" }, { id: "audit-2" }] } },
  };
  const fixture = fixtures[path];
  assert.ok(fixture, `fixture missing for path ${path}`);
  return {
    status: fixture.status,
    ok: fixture.status >= 200 && fixture.status < 300,
    json: async () => (fixture.body === undefined ? {} : fixture.body),
  };
}

function makeStableFixtureTransport() {
  return makeGetOnlyTransport(({ path }) => stableFixtureResponse(path));
}

test("probe issues exactly one GET per section and never a write method", async () => {
  const transport = makeGetOnlyTransport(({ path }) => {
    if (path === "/agents") {
      return { status: 200, ok: true, json: async () => ({ items: [{ id: "a" }] }) };
    }
    return { status: 403, ok: false };
  });
  const report = await collectInventory(transport);

  assert.equal(transport.methods.length, INVENTORY_SECTIONS.length);
  assert.ok(transport.methods.every((method) => method === "GET"));
  assert.deepEqual(transport.seenPaths, INVENTORY_SECTIONS.map((section) => section.path));
  assert.equal(report.summary.total, INVENTORY_SECTIONS.length);
  assert.equal(report.summary.covered, 1);
});

test("write methods are a contract violation the transport refuses", async () => {
  const transport = makeGetOnlyTransport(() => {
    throw new Error("fixture must never be asked to write");
  });
  await assert.rejects(
    transport.request({ method: "POST", path: "/agents" }),
    /unexpected non-GET method/,
  );
  await assert.rejects(
    transport.request({ method: "PUT", path: "/issues" }),
    /unexpected non-GET method/,
  );
  await assert.rejects(
    transport.request({ method: "DELETE", path: "/budgets-costs" }),
    /unexpected non-GET method/,
  );
});

test("two consecutive probe runs on the same stable fixture produce the same normalized summary and hash", async () => {
  const first = await collectInventory(makeStableFixtureTransport());
  const second = await collectInventory(makeStableFixtureTransport());

  assert.deepEqual(first.summary, second.summary);
  assert.deepEqual(first.sections, second.sections);
  assert.deepEqual(normalizeInventoryReport(first), normalizeInventoryReport(second));
  assert.equal(inventoryReportHash(first), inventoryReportHash(second));
  assert.match(inventoryReportHash(first), /^[0-9a-f]{64}$/);

  // Deterministic ordering: normalization sorts object keys, so an equivalently
  // re-keyed report still normalizes and hashes identically.
  const reordered = {
    summary: { counts: second.summary.counts, covered: second.summary.covered, total: second.summary.total },
    sections: second.sections.map(({ path, ...rest }) => ({ ...rest, path })),
  };
  assert.deepEqual(normalizeInventoryReport(reordered), normalizeInventoryReport(second));
  assert.equal(inventoryReportHash(reordered), inventoryReportHash(second));

  assert.equal(JSON.parse(renderInventory(first)).summary.total, INVENTORY_SECTIONS.length);
});

test("stable fixture resolves each section to its expected state and count", async () => {
  const report = await collectInventory(makeStableFixtureTransport());
  const byKey = Object.fromEntries(report.sections.map((section) => [section.key, section]));

  assert.equal(byKey.agents.state, "data");
  assert.equal(byKey.agents.count, 1);
  assert.equal(byKey["projects-documents"].state, "empty");
  assert.equal(byKey["connections-tools"].state, "data");
  assert.equal(byKey["budgets-costs"].state, "empty");
  assert.equal(byKey["audit-approvals"].state, "data");
  assert.equal(byKey["audit-approvals"].count, 2);
  assert.equal(byKey["skills-policies"].state, "denied");
  assert.equal(byKey["secrets-bindings"].state, "not-found");
  assert.equal(byKey["memory-knowledge-sessions"].state, "error");
  assert.equal(byKey["chat-exchange-wake"].state, "error");

  assert.deepEqual(report.summary, {
    total: 10,
    covered: 6,
    counts: { data: 4, empty: 2, denied: 1, "not-found": 1, error: 2 },
  });
  // missingAttribution is computed from the observed fixture rows, not copied
  // from the section registry: a declared field is listed only when at least
  // one returned row lacks it.
  assert.deepEqual(byKey.agents.missingAttribution, []);
  assert.deepEqual(byKey.issues.missingAttribution, ["dependency"]);
  assert.deepEqual(byKey["projects-documents"].missingAttribution, ["ownerCompanyId"]);
  assert.deepEqual(byKey["connections-tools"].missingAttribution, ["ownerCompanyId", "dependency"]);
  assert.deepEqual(byKey["budgets-costs"].missingAttribution, ["ownerCompanyId"]);
  assert.deepEqual(byKey["audit-approvals"].missingAttribution, ["ownerCompanyId", "dependency"]);
  for (const section of report.sections) {
    const definition = sectionForPath(section.path);
    assert.ok(definition, `no registry entry for ${section.path}`);
    if (!section.covered) {
      assert.deepEqual(section.missingAttribution, []);
    }
  }
});

test("a failed GET stays an error-state coverage failure and is never reported as empty", async () => {
  let index = 0;
  const transport = makeGetOnlyTransport(() => {
    index += 1;
    if (index === 1) {
      // Network-level failure: the fetch itself rejects.
      return Promise.reject(new Error("transport failure"));
    }
    if (index === 2) {
      // Non-2xx response.
      return { status: 500, ok: false };
    }
    // 2xx but malformed payload that yields no listable items.
    return { status: 200, ok: true, json: async () => ({ unexpected: true }) };
  });
  const report = await collectInventory(transport);

  assert.equal(report.sections[0].state, "error");
  assert.equal(report.sections[1].state, "error");
  assert.equal(report.sections[2].state, "error");
  for (const section of report.sections.slice(0, 3)) {
    assert.equal(section.covered, false);
    assert.equal(section.count, 0);
    assert.notEqual(section.state, "empty");
    assert.deepEqual(section.missingAttribution, []);
  }
  assert.equal(report.summary.counts.error, INVENTORY_SECTIONS.length);
  assert.equal(report.summary.counts.empty, 0);
  assert.equal(report.summary.covered, 0);
});

test("empty payloads stay covered and remain distinct from denied and not-found", async () => {
  const report = await collectInventory(makeGetOnlyTransport(() => ({ status: 200, ok: true, json: async () => [] })));
  assert.equal(report.summary.counts.empty, INVENTORY_SECTIONS.length);
  assert.equal(report.summary.covered, INVENTORY_SECTIONS.length);
  assert.equal(report.summary.counts.denied, 0);
  assert.equal(report.summary.counts["not-found"], 0);
  // An empty payload observed no rows, so every declared field is reported missing.
  for (const section of report.sections) {
    assert.deepEqual(section.missingAttribution, sectionForPath(section.path).attribution);
  }
});

test("missing attribution fields are computed from observed rows", async () => {
  const report = await collectInventory(
    makeGetOnlyTransport(({ path }) => {
      if (path === "/agents") return { status: 200, ok: true, json: async () => ({ items: [{ id: "a1", ownerCompanyId: "c1" }, { id: "a2" }] }) };
      if (path === "/issues") return { status: 200, ok: true, json: async () => [{ id: "i1", ownerCompanyId: "c1", dependency: "dep-1" }] };
      if (path === "/projects-documents") return { status: 200, ok: true, json: async () => ({ items: [{ id: "p1", ownerCompanyId: null }] }) };
      if (path === "/skills-policies") return { status: 200, ok: true, json: async () => ({ items: [{ id: "s1", dependency: "d1" }] }) };
      return { status: 200, ok: true, json: async () => [] };
    }),
  );
  const byKey = Object.fromEntries(report.sections.map((section) => [section.key, section]));

  assert.equal(byKey.agents.state, "data");
  assert.deepEqual(byKey.agents.missingAttribution, ["ownerCompanyId"]);
  assert.deepEqual(byKey.issues.missingAttribution, []);
  assert.deepEqual(byKey["projects-documents"].missingAttribution, ["ownerCompanyId"]);
  assert.deepEqual(byKey["skills-policies"].missingAttribution, ["ownerCompanyId"]);

  const rendered = renderInventory(report);
  assert.ok(!rendered.includes("c1"));
  assert.ok(!rendered.includes("dep-1"));
  assert.ok(!rendered.includes("a1"));
});

test("unknown sections are absent from the registry and cannot be covered", () => {
  assert.equal(sectionForPath("/not-a-section"), undefined);
  assert.ok(INVENTORY_SECTIONS.every((section) => sectionForPath(section.path)));
});

/* --- Owner attribution formatter: unresolved vs unknown (OPE-12910) --- */

/**
 * Fixture rows with secret-shaped payload values: the formatter must never
 * serialize anything beyond exact safe identifiers.
 */
const OPE_12910_KNOWN_FIXTURE = [
  { id: "obj-known", ownerCompanyId: "c1", secretToken: "pcp_SUPER_SECRET_VALUE", webhookUrl: "https://hooks.internal/never-leak" },
];

const OPE_12910_MISSING_FIXTURE = [
  { id: "obj-no-fields" }, // no owner, no dependency field at all
  "not-an-object", // not even an object
];

const OPE_12910_UNRESOLVED_FIXTURE = [
  { id: "obj-unresolved-owner", ownerCompanyId: "ghost-company" },
  { id: "obj-nonstring-owner", ownerCompanyId: { leaked: "value" } },
  { id: "obj-blank-owner", ownerCompanyId: "   " },
  { id: "obj-bad-dep", dependency: { junk: "payload" } },
  { id: "obj-partial-dep", dependency: { type: "issue" } },
  { id: "obj-null-dep", dependency: null },
];
/**
 * Secret-shaped values placed directly in the identifier slots (review gap:
 * the slots themselves must be gated, not just unrelated payload fields).
 * The owner value below IS in the known set — the gate must still not echo it.
 */
const OPE_12910_SECRET_SLOT_FIXTURE = [
  { id: "obj-secret-owner", ownerCompanyId: "pcp_SECRET_SLOT_OWNER" },
  { id: "obj-secret-dep-id", dependency: { type: "issue", id: "pcp_SECRET_REF_ID", companyId: "c2" } },
  { id: "obj-secret-dep-company", dependency: { type: "issue", id: "issue-9", companyId: "sk-SECRETREFVALUE" } },
  { id: "obj-oversize-owner", ownerCompanyId: `x${"y".repeat(200)}` },
];

test("secret-shaped values in identifier slots are never echoed, even when known", () => {
  const knownWithSecret = ["c1", "pcp_SECRET_SLOT_OWNER"];
  const { rows, summary } = formatOwnerAttribution(OPE_12910_SECRET_SLOT_FIXTURE, {
    currentCompanyId: "c1",
    knownCompanyIds: knownWithSecret,
  });

  const rendered = JSON.stringify(rows);
  assert.ok(!rendered.includes("pcp_SECRET_SLOT_OWNER"), "owner slot must not echo a secret-shaped value");
  assert.ok(!rendered.includes("pcp_SECRET_REF_ID"), "dependency id slot must not echo a secret-shaped value");
  assert.ok(!rendered.includes("sk-SECRETREFVALUE"), "dependency companyId slot must not echo a secret-shaped value");
  assert.ok(!rendered.includes("yyyy"), "oversize owner slot must not echo verbatim");
  assert.equal(summary.resolved, 0, "no secret-slot row may count as resolved");
  assert.equal(summary.unresolved, OPE_12910_SECRET_SLOT_FIXTURE.length);

  const secretOwner = rows.find((row) => row.reason === OWNER_ATTRIBUTION_REASONS.unsafeIdentifier);
  assert.ok(secretOwner, "secret-shaped owner must surface identifier-not-safe-to-echo");
  assert.equal(secretOwner.ownerCompanyId, null, "unsafe owner must never populate ownerCompanyId");
  assert.match(secretOwner.ownerRefHash, /^[0-9a-f]{12}$/, "unsafe owner is pseudonymized, not dropped");

  const secretDepId = rows.find((row) => row.entityRef === formatOwnerAttribution([{ id: "obj-secret-dep-id" }]).rows[0].entityRef);
  assert.ok(secretDepId, "the secret dependency-id fixture must produce a row");
  assert.equal(secretDepId.attribution, "unresolved");
  assert.deepEqual(secretDepId.dependency, { type: "issue", id: null, companyId: "c2" }, "unsafe ref value is dropped from the ref, safe ones stay");
});

test("exact safe identifiers still resolve after the identifier gate", () => {
  const entities = [
    { id: "obj-slug-owner", ownerCompanyId: "c1" },
    { id: "obj-uuid-owner", ownerCompanyId: "9f8d1111-2222-4333-8444-555566667777" },
    { id: "obj-mixed-dep", dependency: { type: "issue", id: "issue-77", companyId: "c2" } },
  ];
  const { rows, summary } = formatOwnerAttribution(entities, {
    currentCompanyId: "c1",
    knownCompanyIds: ["c1", "9f8d1111-2222-4333-8444-555566667777"],
  });
  const byEntity = new Map(rows.map((row) => [row.entityRef, row]));
  const refOf = (id) => byEntity.get(formatOwnerAttribution([{ id }]).rows[0].entityRef);

  assert.equal(refOf("obj-slug-owner").ownerCompanyId, "c1");
  assert.equal(refOf("obj-uuid-owner").ownerCompanyId, "9f8d1111-2222-4333-8444-555566667777");
  assert.deepEqual(refOf("obj-mixed-dep").dependency, { type: "issue", id: "issue-77", companyId: "c2" });
  assert.equal(refOf("obj-mixed-dep").dependencyStatus, "cross-company");
  assert.equal(summary.resolved, 3, "every exact safe identifier must still resolve");
});

test("an object without owner or dependency fields is unknown, not unresolved", () => {
  const { rows, summary } = formatOwnerAttribution(OPE_12910_MISSING_FIXTURE);

  const noFields = rows.find((row) => row.entityRef !== null);
  assert.ok(noFields, "the object fixture must produce an entity row");
  assert.equal(noFields.attribution, "unknown");
  assert.equal(noFields.reason, OWNER_ATTRIBUTION_REASONS.noFields);
  assert.equal(noFields.ownerCompanyId, null);
  assert.ok(isUnresolvedAttribution(noFields.attribution));

  const nonObject = rows.find((row) => row.entityRef === null);
  assert.equal(nonObject.attribution, "unknown");
  assert.equal(nonObject.reason, OWNER_ATTRIBUTION_REASONS.noFields);

  assert.equal(summary.unknown, 2);
  assert.equal(summary.unresolved, 0);
  assert.equal(summary.noOwnerDependencyFields, 2);
});

test("present but unverifiable fields stay unresolved with an exact safe reason", () => {
  const { rows, summary } = formatOwnerAttribution(OPE_12910_UNRESOLVED_FIXTURE, { currentCompanyId: "c1", knownCompanyIds: ["c1"] });
  const byReason = Object.groupBy(rows, (row) => row.reason);

  const unknownCompany = byReason[OWNER_ATTRIBUTION_REASONS.ownerCompanyUnknown][0];
  assert.equal(unknownCompany.attribution, "unresolved");
  assert.equal(unknownCompany.ownerCompanyId, null, "unresolved owner must never fold into a real company id");
  assert.match(unknownCompany.ownerRefHash, /^[0-9a-f]{12}$/);

  assert.equal(byReason[OWNER_ATTRIBUTION_REASONS.ownerRefNotString][0].attribution, "unresolved");
  // Reason precedence is owner-first: obj-bad-dep has no owner field AND a
  // junk dependency ref, so it reports the dependency cause; the other
  // missing-owner rows keep the owner cause.
  const depCauseRow = byReason[OWNER_ATTRIBUTION_REASONS.dependencyRefInvalid]?.[0];
  assert.ok(depCauseRow, "bad dependency ref must surface the dependency cause");
  assert.equal(depCauseRow.attribution, "unresolved");

  const rendered = JSON.stringify(rows);
  assert.ok(!rendered.includes("leaked"), "non-string owner payload must not leak");
  assert.ok(!rendered.includes("junk"), "dependency junk payload must not leak");
  assert.equal(summary.unresolved, OPE_12910_UNRESOLVED_FIXTURE.length);
  assert.equal(summary.resolved, 0);
  for (const row of rows) assert.ok(isUnresolvedAttribution(row.attribution));
});

test("present verifiable fields resolve to exact safe identifiers only", () => {
  const owner = formatOwnerAttribution(OPE_12910_KNOWN_FIXTURE, { currentCompanyId: "c1", knownCompanyIds: ["c1"] });
  assert.equal(owner.rows[0].attribution, "resolved");
  assert.equal(owner.rows[0].ownerCompanyId, "c1");
  assert.equal(owner.rows[0].dependency, null);
  assert.ok(!isUnresolvedAttribution(owner.rows[0].attribution));

  const dependency = formatOwnerAttribution(
    [{ id: "obj-dep", dependency: { type: "issue", id: "issue-77", companyId: "c2" }, title: "payload", secretToken: "pcp_SUPER_SECRET_VALUE" }],
    { currentCompanyId: "c1" },
  );
  const depRow = dependency.rows[0];
  assert.equal(depRow.dependencyStatus, "cross-company");
  assert.deepEqual(depRow.dependency, { type: "issue", id: "issue-77", companyId: "c2" });

  const rendered = JSON.stringify(owner.rows) + JSON.stringify(dependency.rows);
  assert.ok(rendered.includes("issue-77"));
  assert.ok(!rendered.includes("pcp_SUPER_SECRET_VALUE"), "secret token must never enter the output");
  assert.ok(!rendered.includes("never-leak"), "webhook url must never enter the output");
  assert.ok(!rendered.includes("payload"), "unrelated payload fields must never enter the output");
});

test("formatter output is deterministic regardless of input order", () => {
  const entities = [...OPE_12910_KNOWN_FIXTURE, ...OPE_12910_MISSING_FIXTURE, ...OPE_12910_UNRESOLVED_FIXTURE];
  const first = formatOwnerAttribution(entities, { currentCompanyId: "c1", knownCompanyIds: ["c1"] });
  const reversed = formatOwnerAttribution([...entities].reverse(), { currentCompanyId: "c1", knownCompanyIds: ["c1"] });
  assert.deepEqual(first, reversed);
});

test("same-company dependency links stay distinct from unknown company context", () => {
  const rows = formatOwnerAttribution([{ id: "obj-same", dependency: { type: "issue", id: "issue-88", companyId: "c1" } }], { currentCompanyId: "c1" }).rows;
  assert.equal(rows[0].dependencyStatus, "same-company");
  assert.equal(rows[0].attribution, "resolved");

  const noContext = formatOwnerAttribution([{ id: "obj-same", dependency: { type: "issue", id: "issue-88", companyId: "c1" } }]).rows;
  assert.equal(noContext[0].attribution, "unresolved");
  assert.equal(noContext[0].reason, OWNER_ATTRIBUTION_REASONS.currentCompanyUnknown);
  assert.deepEqual(noContext[0].dependency, { type: "issue", id: "issue-88", companyId: "c1" });
});

test("formatter output integrates with the report hash pipeline without leaking secrets", () => {
  const report = {
    sections: [],
    summary: { total: 0, covered: 0, counts: { data: 0, empty: 0, denied: 0, "not-found": 0, error: 0 } },
    attribution: formatOwnerAttribution(OPE_12910_KNOWN_FIXTURE, { currentCompanyId: "c1", knownCompanyIds: ["c1"] }).rows,
  };
  const rendered = renderInventory(report);
  assert.ok(rendered.includes("c1"));
  assert.ok(!rendered.includes("pcp_SUPER_SECRET_VALUE"));
  assert.ok(!rendered.includes("never-leak"));
  assert.equal(inventoryReportHash(report), inventoryReportHash(normalizeInventoryReport(report)));
  assert.match(inventoryReportHash(report), /^[0-9a-f]{64}$/);
});
