import test from "node:test";
import assert from "node:assert/strict";
import {
  collectInventory,
  INVENTORY_METHOD,
  INVENTORY_SECTIONS,
  inventoryReportHash,
  isUnresolvedDependencyStatus,
  formatCrossCompanyDependency,
  formatInventoryDependencies,
  normalizeInventoryReport,
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
  // re-keyed report still normalizes and hashes identically. The dependency
  // view, when present, is carried along with re-keyed rows.
  const reordered = {
    summary: { counts: second.summary.counts, covered: second.summary.covered, total: second.summary.total },
    sections: second.sections.map(({ path, ...rest }) => ({ ...rest, path })),
    dependencies:
      second.dependencies === undefined
        ? undefined
        : second.dependencies.map(({ section, ...rest }) => ({ ...rest, section })),
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

test("a transient transport failure in the first run stays error and the retried run covers the section", async () => {
  const flakyPath = "/agents";
  const pathCalls = new Map();
  // Baseline: every section succeeds with a non-empty payload; only the scripted path flakes.
  const transport = makeGetOnlyTransport(({ path }) => {
    const call = (pathCalls.get(path) ?? 0) + 1;
    pathCalls.set(path, call);
    if (path === flakyPath && call === 1) {
      return Promise.reject(new Error("transient transport failure"));
    }
    return { status: 200, ok: true, json: async () => ({ items: [{ id: `id-${path}` }] }) };
  });

  const first = await collectInventory(transport);
  const firstSection = first.sections.find((section) => section.path === flakyPath);
  assert.equal(firstSection.state, "error");
  assert.equal(firstSection.covered, false);
  assert.equal(firstSection.count, 0);
  assert.deepEqual(firstSection.missingAttribution, []);
  assert.equal(first.summary.counts.error, 1);
  assert.equal(first.summary.counts.empty, 0);
  assert.equal(first.summary.covered, INVENTORY_SECTIONS.length - 1);
  // Exactly one GET for the flaky path in run one: the probe does not retry internally.
  assert.equal(pathCalls.get(flakyPath), 1);

  const second = await collectInventory(transport);
  const secondSection = second.sections.find((section) => section.path === flakyPath);
  assert.equal(secondSection.state, "data");
  assert.equal(secondSection.covered, true);
  assert.equal(secondSection.count, 1);
  assert.deepEqual(secondSection.missingAttribution, [...sectionForPath(flakyPath).attribution]);
  assert.equal(second.summary.counts.error, 0);
  assert.equal(second.summary.covered, INVENTORY_SECTIONS.length);
  assert.equal(pathCalls.get(flakyPath), 2);
});

test("a transient 5xx in the first run stays error and the retried run covers the section", async () => {
  const flakyPath = "/connections-tools";
  const pathCalls = new Map();
  const transport = makeGetOnlyTransport(({ path }) => {
    const call = (pathCalls.get(path) ?? 0) + 1;
    pathCalls.set(path, call);
    if (path === flakyPath && call === 1) {
      return { status: 503, ok: false };
    }
    return { status: 200, ok: true, json: async () => ({ items: [{ id: `id-${path}` }] }) };
  });

  const first = await collectInventory(transport);
  const firstSection = first.sections.find((section) => section.path === flakyPath);
  assert.equal(firstSection.state, "error");
  assert.equal(firstSection.covered, false);
  assert.equal(firstSection.count, 0);
  assert.deepEqual(firstSection.missingAttribution, []);
  assert.equal(first.summary.counts.error, 1);
  assert.equal(first.summary.counts.empty, 0);
  assert.equal(first.summary.covered, INVENTORY_SECTIONS.length - 1);
  assert.equal(pathCalls.get(flakyPath), 1);

  const second = await collectInventory(transport);
  const secondSection = second.sections.find((section) => section.path === flakyPath);
  assert.equal(secondSection.state, "data");
  assert.equal(secondSection.covered, true);
  assert.equal(secondSection.count, 1);
  assert.deepEqual(secondSection.missingAttribution, [...sectionForPath(flakyPath).attribution]);
  assert.equal(second.summary.counts.error, 0);
  assert.equal(second.summary.covered, INVENTORY_SECTIONS.length);
  assert.equal(pathCalls.get(flakyPath), 2);
});

test("when no retry is performed the report keeps surfacing the error instead of an empty inventory", async () => {
  const failingPath = "/chat-exchange-wake";
  const pathCalls = new Map();
  const transport = makeGetOnlyTransport(({ path }) => {
    pathCalls.set(path, (pathCalls.get(path) ?? 0) + 1);
    if (path === failingPath) {
      return { status: 503, ok: false };
    }
    return { status: 200, ok: true, json: async () => ({ items: [{ id: `id-${path}` }] }) };
  });

  for (const run of [1, 2]) {
    const report = await collectInventory(transport);
    const section = report.sections.find((entry) => entry.path === failingPath);
    assert.equal(section.state, "error", `run ${run} must stay error`);
    assert.notEqual(section.state, "empty");
    assert.equal(section.covered, false, `run ${run} must not count as covered`);
    assert.equal(section.count, 0, `run ${run}`);
    assert.deepEqual(section.missingAttribution, [], `run ${run}`);
    assert.equal(report.summary.counts.error, 1, `run ${run}`);
    assert.equal(report.summary.counts.empty, 0, `run ${run}`);
    assert.equal(report.summary.covered, INVENTORY_SECTIONS.length - 1, `run ${run}`);
  }
  // Exactly one GET per run for the failing path: no hidden internal retry, the error stays visible.
  assert.equal(pathCalls.get(failingPath), 2);
  assert.ok(transport.methods.every((method) => method === INVENTORY_METHOD));
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
  // Section metadata stays free of observed row payload values (pre-OPE-12905 intent).
  const sectionsJson = JSON.stringify(report.sections);
  assert.ok(!sectionsJson.includes("c1"));
  assert.ok(!sectionsJson.includes("dep-1"));
  assert.ok(!sectionsJson.includes("a1"));
  // The allowlisted dependency view (OPE-12905) intentionally carries
  // owner/company identifiers for dependency-bearing objects, but raw
  // dependency values (plain strings here) are never copied into the report.
  assert.ok(!rendered.includes("dep-1"));
  assert.ok(!rendered.includes("d1"));
  assert.ok(!rendered.includes("a1"));
});

test("unknown sections are absent from the registry and cannot be covered", () => {
  assert.equal(sectionForPath("/not-a-section"), undefined);
  assert.ok(INVENTORY_SECTIONS.every((section) => sectionForPath(section.path)));
});

/* --- Cross-company dependency visibility (OPE-12905) --- */

/**
 * Fixture A: supported inventory objects that DO carry an explicit
 * cross-company dependency reference (issue → issue in another company).
 * Payload values include secret-shaped strings to prove they never leak.
 */
const CROSS_COMPANY_FIXTURE = [
  {
    id: "issue-9",
    ownerCompanyId: "c1",
    dependency: { type: "issue", id: "issue-77", companyId: "c2" },
    title: "payload must not be copied",
    secretToken: "pcp_SUPER_SECRET_VALUE",
    webhookUrl: "https://hooks.internal/never-leak",
  },
  {
    id: "issue-10",
    ownerCompanyId: "c1",
    dependency: { type: "issue", id: "issue-88", companyId: "c1" },
  },
];

/** Fixture B: same objects but with no reference, or an unresolvable one. */
const UNRESOLVED_FIXTURE = [
  { id: "issue-11", ownerCompanyId: "c1" },
  { id: "issue-12", ownerCompanyId: "c1", dependency: { unresolved: true } },
  { id: "issue-13", ownerCompanyId: "c1", dependency: { type: "issue" } },
  { id: "issue-14", ownerCompanyId: "c1", dependency: null },
  "not-an-object",
];

test("explicit cross-company reference stays visible in the collected report with type and identifier, without payload values", async () => {
  const transport = makeGetOnlyTransport(({ path }) => {
    if (path === "/issues") {
      return { status: 200, ok: true, json: async () => CROSS_COMPANY_FIXTURE };
    }
    return { status: 403, ok: false };
  });
  const report = await collectInventory(transport, { currentCompanyId: "c1" });

  // The path under test IS the report: collectInventory → report.dependencies.
  assert.ok(Array.isArray(report.dependencies), "report must carry the dependency view");
  const cross = report.dependencies.find((d) => d.objectId === "issue-9");
  assert.ok(cross, "report must keep the cross-company object visible");
  assert.equal(cross.section, "issues");
  assert.equal(cross.status, "cross-company");
  assert.deepEqual(cross.dependency, { type: "issue", id: "issue-77", companyId: "c2" });
  assert.equal(cross.ownerCompanyId, "c1");
  assert.ok(isUnresolvedDependencyStatus(cross.status) === false);
  assert.notEqual(cross.status, "unknown");

  const same = report.dependencies.find((d) => d.objectId === "issue-10");
  assert.ok(same, "report must keep the same-company object visible");
  assert.equal(same.status, "same-company");
  assert.deepEqual(same.dependency, { type: "issue", id: "issue-88", companyId: "c1" });

  // Rendered report shows the link type/identifier; payload-only fields never leak.
  const rendered = renderInventory(report);
  assert.ok(rendered.includes("issue-77"));
  assert.ok(rendered.includes("c2"));
  assert.ok(!rendered.includes("pcp_SUPER_SECRET_VALUE"));
  assert.ok(!rendered.includes("never-leak"));
  assert.ok(!rendered.includes("title"));
});

test("missing or unresolvable references stay unknown/unresolved in the collected report and never fold into no-links", async () => {
  const transport = makeGetOnlyTransport(({ path }) => {
    if (path === "/issues") {
      return { status: 200, ok: true, json: async () => UNRESOLVED_FIXTURE };
    }
    return { status: 403, ok: false };
  });
  const report = await collectInventory(transport, { currentCompanyId: "c1" });

  // Unresolvable objects still produce visible rows — absence of links is never
  // reported as "no dependencies" at the report level either.
  assert.ok(Array.isArray(report.dependencies), "unresolved references must stay visible in the report");
  const byId = Object.fromEntries(report.dependencies.filter((d) => d.objectId).map((d) => [d.objectId, d]));

  // No reference at all → status unknown, dependency null — visibly not "no links".
  assert.equal(byId["issue-11"].status, "unknown");
  assert.equal(byId["issue-11"].dependency, null);
  assert.ok(isUnresolvedDependencyStatus(byId["issue-11"].status));

  // dependency.unresolved=true → status unresolved.
  assert.equal(byId["issue-12"].status, "unresolved");
  assert.equal(byId["issue-12"].dependency, null);
  assert.ok(isUnresolvedDependencyStatus(byId["issue-12"].status));

  // Reference present but missing type/id/companyId → unresolved with partial hint.
  assert.equal(byId["issue-13"].status, "unresolved");
  assert.deepEqual(byId["issue-13"].dependency, { type: "issue", id: null, companyId: null });
  assert.ok(isUnresolvedDependencyStatus(byId["issue-13"].status));

  // dependency explicitly null → unresolved (field present but unresolvable).
  assert.equal(byId["issue-14"].status, "unresolved");
  assert.ok(isUnresolvedDependencyStatus(byId["issue-14"].status));

  // Non-object entries produce no link identity at all (status unknown, nothing resolvable).
  assert.equal(report.dependencies.filter((d) => d.objectId === null).length, 1);
  assert.equal(report.dependencies.find((d) => d.objectId === null).status, "unknown");
  assert.equal(report.dependencies.find((d) => d.objectId === null).dependency, null);

  // No state ever collapses into "no links": rows exist for every listed object.
  for (const entry of report.dependencies) {
    assert.ok(["unknown", "unresolved", "same-company", "cross-company"].includes(entry.status));
  }
});

test("report path is deterministic and secret-free; failed sections contribute no rows; empty dependency sections omit the view", async () => {
  // Deterministic across repeated runs: identical collected reports, same hash,
  // input order of the fixture does not change the rendered report.
  const makeTransport = () =>
    makeGetOnlyTransport(({ path }) => {
      if (path === "/issues") {
        return { status: 200, ok: true, json: async () => [...CROSS_COMPANY_FIXTURE].reverse() };
      }
      return { status: 403, ok: false };
    });
  const first = await collectInventory(makeTransport(), { currentCompanyId: "c1" });
  const second = await collectInventory(makeTransport(), { currentCompanyId: "c1" });
  assert.deepEqual(first.dependencies, second.dependencies);
  assert.equal(inventoryReportHash(first), inventoryReportHash(second));
  const rendered = renderInventory(first);
  assert.ok(rendered.includes("issue-77"));
  assert.ok(rendered.includes("c2"));
  assert.ok(!rendered.includes("pcp_SUPER_SECRET_VALUE"));
  assert.ok(!rendered.includes("never-leak"));
  assert.ok(!rendered.includes("title"));

  // Unit-level sorting contract is unchanged: input order never affects the sorted rows.
  assert.deepEqual(
    formatInventoryDependencies([...CROSS_COMPANY_FIXTURE].reverse(), { currentCompanyId: "c1" }),
    formatInventoryDependencies(CROSS_COMPANY_FIXTURE, { currentCompanyId: "c1" }),
  );

  // No dependency-attributed section covered → the report carries no dependencies view at all.
  const noDep = await collectInventory(makeGetOnlyTransport(() => ({ status: 403, ok: false })));
  assert.equal(noDep.dependencies, undefined);
  assert.deepEqual(normalizeInventoryReport(noDep), { sections: noDep.sections, summary: noDep.summary });

  // A covered section without the dependency attribution never contributes rows.
  const agentsOnly = await collectInventory(
    makeGetOnlyTransport(({ path }) => {
      if (path === "/agents") {
        return { status: 200, ok: true, json: async () => [{ id: "a-1", dependency: { type: "issue", id: "x", companyId: "c2" } }] };
      }
      return { status: 403, ok: false };
    }),
    { currentCompanyId: "c1" },
  );
  assert.equal(agentsOnly.dependencies, undefined);
});
