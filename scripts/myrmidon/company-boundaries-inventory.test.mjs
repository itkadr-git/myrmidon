import test from "node:test";
import assert from "node:assert/strict";
import {
  collectInventory,
  INVENTORY_METHOD,
  INVENTORY_SECTIONS,
  inventoryReportHash,
  normalizeInventoryReport,
  renderInventory,
  SOURCE_LABEL_CREDENTIAL_REDACTED,
  SOURCE_LABEL_REASONS,
  formatInventorySourceLabel,
  formatInventorySourceLabels,
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
  for (const section of report.sections) {
    const definition = sectionForPath(section.path);
    assert.ok(definition, `no registry entry for ${section.path}`);
    if (section.covered) {
      assert.deepEqual(section.missingAttribution, definition.attribution);
    } else {
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
});

test("unknown sections are absent from the registry and cannot be covered", () => {
  assert.equal(sectionForPath("/not-a-section"), undefined);
  assert.ok(INVENTORY_SECTIONS.every((section) => sectionForPath(section.path)));
});

/* --- Source attribution without credential leakage (OPE-12912) --- */

/** Source fixture carrying registry-valid labels plus a credential sentinel. */
const SOURCE_FIXTURE_WITH_SENTINEL = {
  endpoint: "/secrets-bindings",
  category: "secrets-bindings",
  coverage: "data",
  credential: "pcp_SENTINEL_CREDENTIAL_VALUE",
  token: "Bearer pcp_SENTINEL_TOKEN_VALUE",
};

test("source with endpoint/category and credential sentinel shows safe labels and coverage, never the sentinel", () => {
  const label = formatInventorySourceLabel(SOURCE_FIXTURE_WITH_SENTINEL);

  // Useful attribution survives.
  assert.equal(label.endpoint, "/secrets-bindings");
  assert.equal(label.category, "secrets-bindings");
  assert.equal(label.coverage, "data");
  assert.equal(label.attribution, "resolved");
  assert.equal(label.reason, null);

  // Credential presence is marked, but every sentinel value is dropped.
  assert.equal(label.credential, SOURCE_LABEL_CREDENTIAL_REDACTED);
  const rendered = JSON.stringify(label);
  assert.ok(!rendered.includes("pcp_SENTINEL_CREDENTIAL_VALUE"));
  assert.ok(!rendered.includes("pcp_SENTINEL_TOKEN_VALUE"));
});

test("incomplete source stays unknown instead of inventing attribution", () => {
  // Missing endpoint entirely.
  const noEndpoint = formatInventorySourceLabel({ category: "agents", coverage: "data" });
  assert.equal(noEndpoint.endpoint, null);
  assert.equal(noEndpoint.attribution, "unknown");
  assert.equal(noEndpoint.reason, SOURCE_LABEL_REASONS.unknownEndpoint);

  // Endpoint not in the registry: the raw string never reaches the report.
  const foreign = formatInventorySourceLabel({ endpoint: "/not-a-section", category: "agents", coverage: "data" });
  assert.equal(foreign.endpoint, null);
  assert.equal(foreign.attribution, "unknown");
  assert.equal(foreign.reason, SOURCE_LABEL_REASONS.unknownEndpoint);
  assert.ok(!JSON.stringify(foreign).includes("/not-a-section"));

  // Known endpoint, wrong category: no fabricated pair.
  const mismatch = formatInventorySourceLabel({ endpoint: "/agents", category: "issues", coverage: "data" });
  assert.equal(mismatch.endpoint, "/agents");
  assert.equal(mismatch.category, null);
  assert.equal(mismatch.attribution, "unknown");
  assert.equal(mismatch.reason, SOURCE_LABEL_REASONS.categoryEndpointMismatch);

  // Category missing for a known endpoint.
  const noCategory = formatInventorySourceLabel({ endpoint: "/agents", coverage: "empty" });
  assert.equal(noCategory.category, null);
  assert.equal(noCategory.attribution, "unknown");
  assert.equal(noCategory.reason, SOURCE_LABEL_REASONS.unknownCategory);

  // Endpoint/category fine but coverage missing or not a coverage state.
  const noCoverage = formatInventorySourceLabel({ endpoint: "/agents", category: "agents" });
  assert.equal(noCoverage.coverage, "unknown");
  assert.equal(noCoverage.attribution, "unknown");
  assert.equal(noCoverage.reason, SOURCE_LABEL_REASONS.coverageUnknown);
  const badCoverage = formatInventorySourceLabel({ endpoint: "/agents", category: "agents", coverage: "probably-fine" });
  assert.equal(badCoverage.coverage, "unknown");
  assert.ok(!JSON.stringify(badCoverage).includes("probably-fine"));
});

test("credential presence is detected across common secret-shaped fields without copying values", () => {
  const fields = ["credential", "credentials", "token", "apiKey", "secret", "password", "authorization"];
  for (const field of fields) {
    const label = formatInventorySourceLabel({
      endpoint: "/agents",
      category: "agents",
      coverage: "data",
      [field]: "pcp_SENTINEL_VALUE",
    });
    assert.equal(label.credential, SOURCE_LABEL_CREDENTIAL_REDACTED, `field ${field} must be marked`);
    assert.ok(!JSON.stringify(label).includes("pcp_SENTINEL_VALUE"));
  }
  // Empty/absent credential fields are not marked.
  const clean = formatInventorySourceLabel({
    endpoint: "/agents",
    category: "agents",
    coverage: "data",
    credential: "",
    token: null,
  });
  assert.equal(clean.credential, null);
});

test("rendered report and hash keep sentinel values out and stay deterministic across runs", () => {
  const sources = [
    { ...SOURCE_FIXTURE_WITH_SENTINEL, endpoint: "/audit-approvals", category: "audit-approvals" },
    SOURCE_FIXTURE_WITH_SENTINEL,
    { endpoint: "/issues", category: "issues", coverage: "denied", apiKey: "pcp_SENTINEL_KEY" },
    { endpoint: "/agents", coverage: "data", category: "agents" },
    "not-an-object",
  ];
  const labels = formatInventorySourceLabels(sources);

  // Deterministic ordering: input order does not change the output.
  assert.deepEqual(labels, formatInventorySourceLabels([...sources].reverse()));
  // Non-object entries and empty input produce no labels, never invented ones.
  assert.equal(labels.filter((label) => label.endpoint === null && label.category === null).length, 1);
  assert.deepEqual(formatInventorySourceLabels(undefined), []);
  assert.deepEqual(formatInventorySourceLabels("nope"), []);

  const rendered = renderInventory({ sections: [], summary: {}, sourceLabels: labels });
  assert.ok(rendered.includes("/secrets-bindings"));
  assert.ok(rendered.includes("secrets-bindings"));
  assert.ok(rendered.includes("denied"));
  for (const forbidden of ["pcp_SENTINEL_CREDENTIAL_VALUE", "pcp_SENTINEL_TOKEN_VALUE", "pcp_SENTINEL_KEY"]) {
    assert.ok(!rendered.includes(forbidden), `${forbidden} must never be rendered`);
  }
  assert.equal(rendered.includes(SOURCE_LABEL_CREDENTIAL_REDACTED), true);

  const hash = inventoryReportHash({ sections: [], summary: {}, sourceLabels: labels });
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, inventoryReportHash({ sections: [], summary: {}, sourceLabels: formatInventorySourceLabels([...sources].reverse()) }));
});

test("every registry section produces a resolved label for its canonical endpoint", () => {
  for (const section of INVENTORY_SECTIONS) {
    const label = formatInventorySourceLabel({ endpoint: section.path, category: section.key, coverage: "data" });
    assert.equal(label.attribution, "resolved", `section ${section.key} must resolve`);
    assert.equal(label.endpoint, section.path);
    assert.equal(label.category, section.key);
    assert.equal(label.credential, null);
  }
});
