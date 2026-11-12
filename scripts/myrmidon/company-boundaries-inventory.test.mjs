// OPE-12871: owner/domain attribution for the company-boundaries inventory.
//
// The attribution contract under test:
// - an entity with a verifiable owner field (assigneeAgentId / reportsTo /
//   leadAgentId / ownerUserId) attributes itself to that owner id;
// - an entity without any verifiable owner field reports owner "unknown" —
//   never a guess, never a value derived from names or titles;
// - domain attribution only uses declared domain fields (entity domain,
//   metadata.domain) or the declared sharing scope;
// - sensitive values (secret material, tokens, ciphertext) never surface in
//   the attribution summary, and unknown owners never echo raw ids.
//
// OPE-12872 (skills domain): a company skill attributes its owner ONLY from
// the explicit fork metadata fields (metadata.forkedByAgentId /
// metadata.forkedByUserId) — never from authorName or the external
// GitHub/skills.sh metadata.owner, which are source provenance. The declared
// domain is the sharingScope boundary field: public_link is externally
// reachable, company/private are company-scoped, anything else is unknown.
//
// OPE-12872 wiring (review fix): collectInventory attributes every covered
// section row with a defined owner mapping into the report itself — the
// report carries per-section `ownership` summaries plus a top-level
// `attribution` summary, normalized and hashed with the report; covered
// sections without a mapping stay without an ownership block.
//
// The probe-contract tests below (GET-only transport, stable fixture,
// normalization/hash) are the OPE-12873 behavioral contract from main,
// extended only where the report gained the attribution field.

import test from "node:test";
import assert from "node:assert/strict";
import {
  attributeOwnership,
  collectInventory,
  INVENTORY_METHOD,
  INVENTORY_SECTIONS,
  inventoryReportHash,
  normalizeInventoryReport,
  renderInventory,
  sectionForPath,
  summarizeAttribution,
} from "./company-boundaries-inventory.mjs";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";

test("an issue with an assignee attributes to that owner agent id", () => {
  const result = attributeOwnership("issues", {
    id: "issue-1",
    assigneeAgentId: AGENT_ID,
    title: "secret-heavy incident",
  });
  assert.equal(result.owner, AGENT_ID);
  assert.equal(result.ownerSource, "assigneeAgentId");
  assert.equal(result.ownerKnown, true);
});

test("an issue assigned to a user attributes to that owner user id", () => {
  const result = attributeOwnership("issues", {
    id: "issue-2",
    assigneeUserId: USER_ID,
  });
  assert.equal(result.owner, USER_ID);
  assert.equal(result.ownerSource, "assigneeUserId");
  assert.equal(result.ownerKnown, true);
});

test("an issue without any owner field reports unknown, not a guess", () => {
  const result = attributeOwnership("issues", {
    id: "issue-3",
    title: "nobody owns this",
    // A title that contains an agent name must NOT become an owner.
    assigneeAgentId: null,
    assigneeUserId: null,
  });
  assert.equal(result.owner, "unknown");
  assert.equal(result.ownerSource, null);
  assert.equal(result.ownerKnown, false);
});

test("empty-string and whitespace owner fields are not owners", () => {
  const result = attributeOwnership("issues", {
    id: "issue-4",
    assigneeAgentId: "   ",
    assigneeUserId: "",
  });
  assert.equal(result.owner, "unknown");
  assert.equal(result.ownerKnown, false);
});

test("agents attribute to their reportsTo leader", () => {
  const result = attributeOwnership("agents", {
    id: "agent-1",
    reportsTo: AGENT_ID,
  });
  assert.equal(result.owner, AGENT_ID);
  assert.equal(result.ownerSource, "reportsTo");
  assert.equal(result.ownerKnown, true);
});

test("root agents without a leader are unknown owners", () => {
  const result = attributeOwnership("agents", { id: "agent-root", reportsTo: null });
  assert.equal(result.owner, "unknown");
  assert.equal(result.ownerKnown, false);
});

test("projects attribute to their lead agent", () => {
  const result = attributeOwnership("projects-documents", {
    id: PROJECT_ID,
    leadAgentId: OTHER_AGENT_ID,
  });
  assert.equal(result.owner, OTHER_AGENT_ID);
  assert.equal(result.ownerSource, "leadAgentId");
  assert.equal(result.ownerKnown, true);
});

test("explicit domain metadata is honored verbatim (normalized)", () => {
  const result = attributeOwnership("agents", {
    id: "agent-2",
    reportsTo: null,
    domain: "BBQ",
  });
  assert.equal(result.domain, "bbq");
  assert.equal(result.domainSource, "domain");
});

test("metadata.domain is honored as a declared domain field", () => {
  const result = attributeOwnership("agents", {
    id: "agent-3",
    reportsTo: null,
    metadata: { domain: "work" },
  });
  assert.equal(result.domain, "work");
  assert.equal(result.domainSource, "metadata.domain");
});

test("no declared domain field leaves the domain unknown", () => {
  // Entities that name no domain must not be guessed into one.
  const result = attributeOwnership("agents", { id: "agent-4", reportsTo: null });
  assert.equal(result.domain, "unknown");
  assert.equal(result.domainSource, null);
});

test("an attributed owner passes its id through for cross-reference", () => {
  const result = attributeOwnership("issues", { id: "issue-5", assigneeAgentId: AGENT_ID });
  assert.equal(result.ownerRef, AGENT_ID);
  const unknown = attributeOwnership("issues", { id: "issue-6" });
  assert.equal(unknown.ownerRef, null);
});

test("attribution summary is deterministic for the same input set", () => {
  const rows = [
    { id: "a", assigneeAgentId: AGENT_ID },
    { id: "b", assigneeAgentId: AGENT_ID },
    { id: "c" },
    { id: "d", assigneeUserId: USER_ID },
  ];
  const first = summarizeAttribution(rows.map((row) => attributeOwnership("issues", row)));
  const second = summarizeAttribution(rows.map((row) => attributeOwnership("issues", row)));
  assert.deepEqual(first, second);
  assert.deepEqual(first.owners, [
    { owner: AGENT_ID, known: true, count: 2 },
    { owner: USER_ID, known: true, count: 1 },
    { owner: "unknown", known: false, count: 1 },
  ]);
  assert.equal(first.total, 4);
  assert.equal(first.knownOwners, 3);
  assert.equal(first.unknownOwners, 1);
});

test("attribution summary never contains sensitive values", () => {
  const rows = [
    {
      id: "s1",
      assigneeAgentId: AGENT_ID,
      valueCiphertext: "super-secret-ciphertext",
      apiKey: "pcp_live_key_value",
      token: "bearer-token-value",
      password: "hunter2",
      material: "raw-secret-material",
      secret: "plain-secret",
    },
    { id: "s2", value: "another-secret-value" },
  ];
  const summary = summarizeAttribution(
    rows.map((row) => attributeOwnership("secrets-bindings", row)),
  );
  const serialized = JSON.stringify(summary);
  for (const sensitive of [
    "super-secret-ciphertext",
    "pcp_live_key_value",
    "bearer-token-value",
    "hunter2",
    "raw-secret-material",
    "plain-secret",
    "another-secret-value",
  ]) {
    assert.ok(!serialized.includes(sensitive), `summary leaked ${sensitive}`);
  }
  // Owners are ids or the literal unknown marker only.
  for (const entry of summary.owners) {
    assert.ok(entry.owner === "unknown" || /^[0-9a-f-]{36}$/i.test(entry.owner));
  }
});

test("unknown owner entries never echo titles or free-text fields", () => {
  const rows = [
    { id: "t1", title: "ADM infra bootstrap runbook", assigneeAgentId: null },
    { id: "t2", name: "myrmidon-bot-adm-dev-19", assigneeAgentId: null },
  ];
  const summary = summarizeAttribution(rows.map((row) => attributeOwnership("issues", row)));
  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes("runbook"));
  assert.ok(!serialized.includes("myrmidon-bot"));
  assert.equal(serialized.includes("unknown"), true);
});

test("unrecognized section kinds do not invent owners", () => {
  const result = attributeOwnership("not-a-section", { id: "x", ownerAgentId: AGENT_ID });
  assert.equal(result.owner, "unknown");
  assert.equal(result.ownerKnown, false);
});

// --- OPE-12872: skills domain ---

test("a forked skill attributes to the agent that forked it", () => {
  const result = attributeOwnership("skills-policies", {
    id: "skill-1",
    name: "deploy-runbook",
    authorName: "some-github-user",
    metadata: { forkedByAgentId: AGENT_ID },
  });
  assert.equal(result.owner, AGENT_ID);
  assert.equal(result.ownerSource, "metadata.forkedByAgentId");
  assert.equal(result.ownerKnown, true);
});

test("a forked skill attributes to the forking user when no agent is recorded", () => {
  const result = attributeOwnership("skills-policies", {
    id: "skill-2",
    metadata: { forkedByAgentId: null, forkedByUserId: USER_ID },
  });
  assert.equal(result.owner, USER_ID);
  assert.equal(result.ownerSource, "metadata.forkedByUserId");
  assert.equal(result.ownerKnown, true);
});

test("a skill without fork metadata reports unknown owner, never authorName", () => {
  const result = attributeOwnership("skills-policies", {
    id: "skill-3",
    authorName: "alice",
    metadata: { forkedByAgentId: null, forkedByUserId: null },
  });
  assert.equal(result.owner, "unknown");
  assert.equal(result.ownerSource, null);
  assert.equal(result.ownerKnown, false);
});

test("the external source owner in metadata is not company ownership", () => {
  // skills.sh / GitHub provenance (metadata.owner) must not become the
  // attributed owner: it is not a company member id.
  const result = attributeOwnership("skills-policies", {
    id: "skill-4",
    metadata: { owner: "some-vendor", repo: "some-repo" },
  });
  assert.equal(result.owner, "unknown");
  assert.equal(result.ownerKnown, false);
});

test("a public_link skill declares the public_link domain from sharingScope", () => {
  const result = attributeOwnership("skills-policies", {
    id: "skill-5",
    sharingScope: "public_link",
    metadata: { forkedByAgentId: AGENT_ID },
  });
  assert.equal(result.domain, "public_link");
  assert.equal(result.domainSource, "sharingScope");
});

test("company and private sharing scopes declare the company domain", () => {
  for (const sharingScope of ["company", "private"]) {
    const result = attributeOwnership("skills-policies", {
      id: `skill-${sharingScope}`,
      sharingScope,
    });
    assert.equal(result.domain, "company");
    assert.equal(result.domainSource, "sharingScope");
  }
});

test("a skill with no declared scope keeps an unknown domain", () => {
  const result = attributeOwnership("skills-policies", { id: "skill-6", sharingScope: null });
  assert.equal(result.domain, "unknown");
  assert.equal(result.domainSource, null);
});

test("an explicit domain field still wins over sharingScope", () => {
  const result = attributeOwnership("skills-policies", {
    id: "skill-7",
    domain: "Tenders",
    sharingScope: "public_link",
  });
  assert.equal(result.domain, "tenders");
  assert.equal(result.domainSource, "domain");
});

test("skills attribution summary is deterministic and secret-free", () => {
  const rows = [
    { id: "s1", sharingScope: "company", metadata: { forkedByAgentId: AGENT_ID } },
    { id: "s2", sharingScope: "company", metadata: { forkedByAgentId: AGENT_ID } },
    { id: "s3", sharingScope: "public_link", metadata: { forkedByUserId: USER_ID } },
    { id: "s4", sharingScope: "company", metadata: {} },
    {
      id: "s5",
      sharingScope: "company",
      value: "secret-skill-material",
      metadata: { forkedByAgentId: "   " },
    },
  ];
  const first = summarizeAttribution(rows.map((row) => attributeOwnership("skills-policies", row)));
  const second = summarizeAttribution(rows.map((row) => attributeOwnership("skills-policies", row)));
  assert.deepEqual(first, second);
  assert.equal(first.total, 5);
  assert.equal(first.knownOwners, 3);
  assert.equal(first.unknownOwners, 2);
  assert.deepEqual(first.owners, [
    { owner: AGENT_ID, known: true, count: 2 },
    { owner: USER_ID, known: true, count: 1 },
    { owner: "unknown", known: false, count: 2 },
  ]);
  assert.deepEqual(first.domains, { company: 4, public_link: 1 });
  const serialized = JSON.stringify(first);
  assert.ok(!serialized.includes("secret-skill-material"));
});

// --- Probe contract (OPE-12873 behavioral suite, extended for attribution) ---

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
  // OPE-12872: the covered mapped section carries an ownership block.
  assert.deepEqual(report.sections.find((s) => s.key === "agents").ownership, {
    total: 1,
    knownOwners: 0,
    unknownOwners: 1,
    owners: [{ owner: "unknown", known: false, count: 1 }],
    domains: { unknown: 1 },
  });
  assert.equal(report.attribution.total, 1);
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
  // re-keyed report (including the OPE-12872 attribution field) still
  // normalizes and hashes identically.
  const reordered = {
    summary: { counts: second.summary.counts, covered: second.summary.covered, total: second.summary.total },
    attribution: second.attribution,
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
  for (const section of report.sections) {
    const definition = sectionForPath(section.path);
    assert.ok(definition, `no registry entry for ${section.path}`);
    if (section.covered) {
      assert.deepEqual(section.missingAttribution, definition.attribution);
    } else {
      assert.deepEqual(section.missingAttribution, []);
    }
  }

  // OPE-12872: mapped covered sections carry ownership; unmapped ones never do.
  assert.deepEqual(byKey.agents.ownership, {
    total: 1,
    knownOwners: 0,
    unknownOwners: 1,
    owners: [{ owner: "unknown", known: false, count: 1 }],
    domains: { unknown: 1 },
  });
  assert.deepEqual(byKey.issues.ownership, {
    total: 1,
    knownOwners: 0,
    unknownOwners: 1,
    owners: [{ owner: "unknown", known: false, count: 1 }],
    domains: { unknown: 1 },
  });
  // projects-documents and budgets-costs are covered-empty mapped sections:
  // they carry the empty ownership block; denied/not-found/error and unmapped
  // covered sections carry none.
  const EMPTY_OWNERSHIP = { total: 0, knownOwners: 0, unknownOwners: 0, owners: [], domains: {} };
  assert.deepEqual(byKey["projects-documents"].ownership, EMPTY_OWNERSHIP);
  assert.equal(byKey["connections-tools"].ownership, undefined);
  assert.equal(byKey["budgets-costs"].ownership, undefined);
  assert.equal(byKey["audit-approvals"].ownership, undefined);
  assert.equal(byKey["skills-policies"].ownership, undefined);
  assert.equal(byKey["secrets-bindings"].ownership, undefined);
  assert.equal(byKey["memory-knowledge-sessions"].ownership, undefined);
  assert.equal(byKey["chat-exchange-wake"].ownership, undefined);
  // Aggregate attribution covers agents + issues rows (2 unknown) and the
  // covered-empty mapped section (0 rows).
  assert.deepEqual(report.attribution, {
    total: 2,
    knownOwners: 0,
    unknownOwners: 2,
    owners: [{ owner: "unknown", known: false, count: 2 }],
    domains: { unknown: 2 },
  });
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
  assert.equal(report.attribution.total, 0);
});

test("empty payloads stay covered and remain distinct from denied and not-found", async () => {
  const report = await collectInventory(makeGetOnlyTransport(() => ({ status: 200, ok: true, json: async () => [] })));
  assert.equal(report.summary.counts.empty, INVENTORY_SECTIONS.length);
  assert.equal(report.summary.covered, INVENTORY_SECTIONS.length);
  assert.equal(report.summary.counts.denied, 0);
  assert.equal(report.summary.counts["not-found"], 0);
});

test("403 and 404 map to denied and not-found without coverage or attribution", async () => {
  let index = 0;
  const report = await collectInventory(makeGetOnlyTransport(() => {
    index += 1;
    return index % 2 === 1
      ? { status: 403, ok: false }
      : { status: 404, ok: false };
  }));
  assert.equal(report.summary.counts.denied, 5);
  assert.equal(report.summary.counts["not-found"], 5);
  assert.equal(report.summary.covered, 0);
  for (const section of report.sections) {
    assert.equal(section.covered, false);
    assert.deepEqual(section.missingAttribution, []);
    assert.equal(section.ownership, undefined);
  }
  assert.equal(report.attribution.total, 0);
  assert.deepEqual(report.attribution.owners, []);
});

test("success with data rows marks every section covered with counts", async () => {
  const report = await collectInventory(makeGetOnlyTransport(() =>
    ({ status: 200, ok: true, json: async () => ({ items: [{ id: "a" }] }) })));
  assert.equal(report.summary.total, INVENTORY_SECTIONS.length);
  assert.equal(report.summary.covered, INVENTORY_SECTIONS.length);
  assert.equal(report.summary.counts.data, INVENTORY_SECTIONS.length);
});

test("unknown sections are absent from the registry and cannot be covered", () => {
  assert.equal(sectionForPath("/not-a-section"), undefined);
  assert.ok(INVENTORY_SECTIONS.every((section) => sectionForPath(section.path)));
});

// --- OPE-12872 wiring: attribution inside the inventory report path ---

const SKILL_ROW = {
  id: "skill-report-1",
  name: "public skill with fork owner",
  authorName: "external-author",
  sharingScope: "public_link",
  metadata: { forkedByAgentId: AGENT_ID, owner: "vendor" },
};

test("collectInventory attributes skills rows into the section report", async () => {
  const report = await collectInventory(makeGetOnlyTransport(({ path }) =>
    path === "/skills-policies"
      ? { status: 200, ok: true, json: async () => ({ items: [SKILL_ROW, { id: "skill-report-2", sharingScope: "company" }] }) }
      : { status: 403, ok: false }));
  const skills = report.sections.find((section) => section.key === "skills-policies");
  assert.equal(skills.state, "data");
  assert.equal(skills.count, 2);
  assert.ok(skills.ownership, "covered skills section must carry an ownership summary");
  assert.equal(skills.ownership.total, 2);
  assert.equal(skills.ownership.knownOwners, 1);
  assert.equal(skills.ownership.unknownOwners, 1);
  assert.deepEqual(skills.ownership.owners, [
    { owner: AGENT_ID, known: true, count: 1 },
    { owner: "unknown", known: false, count: 1 },
  ]);
  assert.deepEqual(skills.ownership.domains, { company: 1, public_link: 1 });
  // Top-level attribution aggregates every attributed section.
  assert.deepEqual(report.attribution, skills.ownership);
  // The report never echoes payload rows or sensitive provenance.
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("external-author"));
  assert.ok(!serialized.includes("vendor"));
  assert.ok(!serialized.includes("public skill with fork owner"));
});

test("covered sections without an owner mapping carry no ownership block", async () => {
  const report = await collectInventory(makeGetOnlyTransport(() =>
    ({ status: 200, ok: true, json: async () => ({ items: [{ id: "budget-1", token: "leak-me-not" }] }) })));
  const budgets = report.sections.find((section) => section.key === "budgets-costs");
  assert.equal(budgets.covered, true);
  assert.equal(budgets.ownership, undefined);
  const serialized = renderInventory(report);
  assert.ok(!serialized.includes("leak-me-not"));
});

test("denied and empty states never invent ownership attribution", async () => {
  let index = 0;
  const report = await collectInventory(makeGetOnlyTransport(() => {
    index += 1;
    return index % 2 === 1
      ? { status: 403, ok: false }
      : { status: 200, ok: true, json: async () => [] };
  }));
  const skills = report.sections.find((section) => section.key === "skills-policies");
  // A covered skills section carries an ownership block even when empty;
  // sections without a mapping never invent one.
  assert.equal(skills.ownership.total, 0);
  for (const section of report.sections) {
    if (["issues", "skills-policies"].includes(section.key)) {
      assert.deepEqual(section.ownership, { total: 0, knownOwners: 0, unknownOwners: 0, owners: [], domains: {} });
    } else {
      assert.equal(section.ownership, undefined);
    }
  }
  assert.equal(report.attribution.total, 0);
  assert.deepEqual(report.attribution.owners, []);
});

test("summary is repeatable for the same transport (with attribution)", async () => {
  const transport = makeGetOnlyTransport(({ path }) =>
    path === "/skills-policies"
      ? { status: 200, ok: true, json: async () => ({ items: [SKILL_ROW] }) }
      : path === "/issues"
        ? { status: 200, ok: true, json: async () => ({ items: [{ id: "issue-r1", assigneeAgentId: OTHER_AGENT_ID }] }) }
        : { status: 403, ok: false });
  const first = await collectInventory(transport);
  const second = await collectInventory(transport);
  assert.deepEqual(first, second);
  const parsed = JSON.parse(renderInventory(first));
  assert.equal(parsed.attribution.total, 2);
  assert.deepEqual(parsed.attribution.owners, [
    { owner: AGENT_ID, known: true, count: 1 },
    { owner: OTHER_AGENT_ID, known: true, count: 1 },
  ]);
  assert.equal(parsed.summary.total, INVENTORY_SECTIONS.length);
  assert.equal(inventoryReportHash(first), inventoryReportHash(second));
});
