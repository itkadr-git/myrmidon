import test from "node:test";
import assert from "node:assert/strict";
import {
  collectInventory,
  INVENTORY_METHOD,
  INVENTORY_SECTIONS,
  inventoryReportHash,
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
});

test("unknown sections are absent from the registry and cannot be covered", () => {
  assert.equal(sectionForPath("/not-a-section"), undefined);
  assert.ok(INVENTORY_SECTIONS.every((section) => sectionForPath(section.path)));
});
