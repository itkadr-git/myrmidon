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
// Sentinel secrets are assembled from fragments so this committed test file
// never itself contains a literal that secret scanners would flag.
const BOARD_KEY_SENTINEL = ["pc", "p_board_sentinelvalue123"].join("");
const OPENAI_KEY_SENTINEL = ["sk-", "sentinelopenaikey123456"].join("");
const GITHUB_TOKEN_SENTINEL = ["ghp_", "sentinelgithubtoken12345"].join("");
const AWS_KEY_SENTINEL = ["AKIA", "SENTINELAWSKEY12"].join("");
const BEARER_SENTINEL = ["Bearer ", "sentinelbearertoken123456"].join("");
const SENTINELS = [
  BOARD_KEY_SENTINEL,
  OPENAI_KEY_SENTINEL,
  GITHUB_TOKEN_SENTINEL,
  AWS_KEY_SENTINEL,
  BEARER_SENTINEL,
];

/** 200-with-data fixture whose payload items carry sentinel secrets in source metadata. */
function makeSentinelFixtureTransport() {
  return makeGetOnlyTransport(({ path }) => ({
    status: 200,
    ok: true,
    json: async () => ({
      items: [
        {
          id: `item-for-${path}`,
          ownerCompanyId: "c1",
          sourceMetadata: {
            sourceUrl: `https://inventory-source.example/${BOARD_KEY_SENTINEL}`,
            token: OPENAI_KEY_SENTINEL,
            credential: `${BEARER_SENTINEL}`,
          },
        },
        {
          id: `second-for-${path}`,
          ownerCompanyId: "c2",
          sourceMetadata: {
            sourceUrl: `https://inventory-source.example/${GITHUB_TOKEN_SENTINEL}`,
            token: AWS_KEY_SENTINEL,
          },
        },
      ],
    }),
  }));
}

test("summary keeps safe endpoint/type/status fields while no sentinel reaches any output field", async () => {
  const report = await collectInventory(makeSentinelFixtureTransport());

  // Coverage mapping is unaffected: every section resolved as data.
  assert.equal(report.summary.total, INVENTORY_SECTIONS.length);
  assert.equal(report.summary.covered, INVENTORY_SECTIONS.length);
  assert.equal(report.summary.counts.data, INVENTORY_SECTIONS.length);

  // Every output surface (probe report, sections, summary, rendered string) is sentinel-free.
  const rendered = renderInventory(report);
  const outputs = new Set([JSON.stringify(report), JSON.stringify(report.summary), rendered]);
  for (const sentinel of SENTINELS) {
    for (const output of outputs) {
      assert.equal(output.includes(sentinel), false, `sentinel leaked into output: ${sentinel.slice(0, 3)}…`);
    }
  }

  // Safe fields survive verbatim in the rendered summary: endpoints, section keys, states, counts.
  const parsed = JSON.parse(rendered);
  assert.deepEqual(parsed.sections, report.sections);
  assert.deepEqual(parsed.summary, report.summary);
  assert.deepEqual(
    parsed.sections.map((section) => [section.path, section.key, section.state, section.count]),
    INVENTORY_SECTIONS.map((definition) => [definition.path, definition.key, "data", 2]),
  );
});

test("renderInventory masks secret-shaped values a regression injects into output fields", () => {
  // A future regression that copies payload values into the report must still render safely.
  const poisoned = {
    sections: [
      {
        key: "agents",
        path: "/agents",
        state: "data",
        covered: true,
        count: 1,
        missingAttribution: [],
        sourceUrl: `https://inventory-source.example/${BOARD_KEY_SENTINEL}`,
        token: OPENAI_KEY_SENTINEL,
        credential: BEARER_SENTINEL,
      },
    ],
    summary: {
      total: 1,
      covered: 1,
      counts: { data: 1, empty: 0, denied: 0, "not-found": 0, error: 0 },
      note: GITHUB_TOKEN_SENTINEL,
      awsKey: AWS_KEY_SENTINEL,
    },
  };

  const rendered = renderInventory(poisoned);
  for (const sentinel of SENTINELS) {
    assert.equal(rendered.includes(sentinel), false, `sentinel leaked into rendered summary: ${sentinel.slice(0, 3)}…`);
  }

  // Safe endpoint/type/status fields are preserved; only secret-shaped values are masked.
  const parsed = JSON.parse(rendered);
  assert.equal(parsed.sections[0].path, "/agents");
  assert.equal(parsed.sections[0].key, "agents");
  assert.equal(parsed.sections[0].state, "data");
  assert.equal(parsed.sections[0].count, 1);
  assert.equal(parsed.sections[0].sourceUrl, "https://inventory-source.example/[REDACTED]");
  assert.equal(parsed.sections[0].token, "[REDACTED]");
  assert.equal(parsed.sections[0].credential, "[REDACTED]");
  assert.equal(parsed.summary.note, "[REDACTED]");
  assert.equal(parsed.summary.awsKey, "[REDACTED]");
  assert.equal(parsed.summary.covered, 1);
});

test("ordinary data leaves the coverage mapping and rendering unchanged", async () => {
  const report = await collectInventory(makeStableFixtureTransport());

  const rendered = renderInventory(report);
  assert.deepEqual(JSON.parse(rendered), normalizeInventoryReport(report));
  assert.equal(rendered, JSON.stringify(normalizeInventoryReport(report)));
  assert.match(inventoryReportHash(report), /^[0-9a-f]{64}$/);

  // The canonical stable-fixture summary is byte-identical to the pre-sanitizer expectation.
  assert.deepEqual(report.summary, {
    total: 10,
    covered: 6,
    counts: { data: 4, empty: 2, denied: 1, "not-found": 1, error: 2 },
  });
  assert.equal(
    inventoryReportHash(report),
    inventoryReportHash(await collectInventory(makeStableFixtureTransport())),
  );
});
