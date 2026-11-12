// TDD RED: owner/domain attribution for the company-boundaries inventory.
//
// The attribution contract under test:
// - an entity with a verifiable owner field (ownerAgentId / assigneeAgentId /
//   reportsTo / leadAgentId / ownerUserId) attributes itself to that owner id;
// - an entity without any verifiable owner field reports owner "unknown" —
//   never a guess, never a value derived from names or titles;
// - domain attribution only uses declared domain fields (entity domain,
//   metadata.domain) or an owner id that was itself attributed to a domain —
//   unknown stays unknown;
// - sensitive values (secret material, tokens, ciphertext) never surface in
//   the attribution summary, and unknown owners never echo raw ids.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  ATTRIBUTION_REPORT_SCHEMA,
  EXIT_OK,
  EXIT_USAGE,
  SUPPORTED_DOMAINS,
  attributeInventoryReport,
  attributeOwnership,
  buildAttributionReport,
  isSupportedDomain,
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

test("domain falls back to the ADM company boundary only for non-company entity ids", () => {
  // Entities that name no domain and have no owner must not be guessed into a
  // domain; the only derivable attribution is the board company itself.
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

// ---------------------------------------------------------------------------
// Review round 2: domain allowlist + report wiring (behavioral coverage)
// ---------------------------------------------------------------------------

test("declared domain outside the supported allowlist collapses to unknown", () => {
  const result = attributeOwnership("projects-documents", {
    id: "proj-1",
    leadAgentId: AGENT_ID,
    domain: "PROD-DB-PASSWORD",
  });
  assert.equal(result.domain, "unknown");
  assert.equal(result.domainSource, "domain");
  assert.equal(result.owner, AGENT_ID);
});

test("metadata.domain outside the allowlist is not copied into the result", () => {
  const result = attributeOwnership("secrets-bindings", {
    id: "sec-1",
    ownerUserId: USER_ID,
    metadata: { domain: "internal-hostname.corp.example" },
  });
  assert.equal(result.domain, "unknown");
  assert.equal(result.domainSource, "metadata.domain");
});

test("every supported domain identifier is allowlisted", () => {
  for (const domain of ["adm", "bbq", "life", "work", "company", "public_link"]) {
    assert.equal(isSupportedDomain(domain), true, domain);
  }
  assert.equal(isSupportedDomain("nope"), false);
  assert.equal(isSupportedDomain(""), false);
  assert.equal(isSupportedDomain(null), false);
  assert.equal(SUPPORTED_DOMAINS.has("adm"), true);
});

test("supported declared domain survives attribution (canonical lowercase)", () => {
  const result = attributeOwnership("issues", {
    id: "i-1",
    assigneeAgentId: AGENT_ID,
    domain: "BBQ",
  });
  assert.equal(result.domain, "bbq");
  assert.equal(result.domainSource, "domain");
});

test("attribution summary contains no sensitive values (leak check)", () => {
  const SECRET = "hunter2-super-secret-value";
  const rows = [
    {
      id: "i-1",
      title: `leak marker ${SECRET}`,
      description: SECRET,
      body: SECRET,
      assigneeAgentId: AGENT_ID,
      domain: SECRET,
      metadata: { domain: SECRET, token: SECRET },
      value: SECRET,
      token: SECRET,
      apiKey: SECRET,
    },
    {
      id: "i-2",
      title: "no owner",
      assigneeAgentId: null,
      metadata: { domain: SECRET },
    },
  ];
  const summary = summarizeAttribution(rows.map((row) => attributeOwnership("issues", row)));
  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes(SECRET));
  assert.equal(summary.total, 2);
  assert.equal(summary.knownOwners, 1);
  assert.equal(summary.unknownOwners, 1);
  assert.deepEqual(summary.owners, [
    { owner: AGENT_ID, known: true, count: 1 },
    { owner: "unknown", known: false, count: 1 },
  ]);
  // Arbitrary domain strings never reach the summary keys.
  assert.deepEqual(Object.keys(summary.domains), ["unknown"]);
});

test("attribution summary domains are deterministically sorted", () => {
  const rows = [
    { id: "1", assigneeAgentId: AGENT_ID, domain: "work" },
    { id: "2", assigneeAgentId: AGENT_ID, domain: "adm" },
    { id: "3", assigneeAgentId: AGENT_ID, domain: "bbq" },
  ];
  const summary = summarizeAttribution(rows.map((row) => attributeOwnership("issues", row)));
  assert.deepEqual(Object.keys(summary.domains), ["adm", "bbq", "work"]);
  const again = summarizeAttribution([...rows].reverse().map((row) => attributeOwnership("issues", row)));
  assert.deepEqual(again, summary);
});

test("attributeInventoryReport wires captured sections into per-section summaries", () => {
  const sections = {
    issues: [
      { id: "i-1", assigneeAgentId: AGENT_ID, domain: "adm" },
      { id: "i-2", assigneeAgentId: null },
    ],
    agents: [{ id: "a-1", reportsTo: "lead-1" }],
    projects: [{ id: "p-1", leadAgentId: AGENT_ID, domain: "work" }],
    secretBindings: [{ id: "s-1", ownerUserId: USER_ID, metadata: { domain: "bbq" } }],
    ignored: [{ id: "x-1", assigneeAgentId: AGENT_ID }],
    summary: { total: 99 },
    notArray: "nope",
  };
  const report = attributeInventoryReport(sections);
  assert.deepEqual(Object.keys(report.sections).sort(), ["agents", "issues", "projects-documents", "secrets-bindings"]);
  assert.equal(report.sections.issues.total, 2);
  assert.equal(report.sections.issues.knownOwners, 1);
  assert.deepEqual(report.sections.issues.domains, { adm: 1, unknown: 1 });
  assert.equal(report.sections.agents.total, 1);
  assert.deepEqual(report.sections["projects-documents"].domains, { work: 1 });
  assert.deepEqual(report.sections["secrets-bindings"].domains, { bbq: 1 });
  // Unmapped sections are ignored without invention.
  assert.equal(report.sections.ignored, undefined);
  assert.equal(attributeInventoryReport(null).sections.agents, undefined);
  assert.deepEqual(attributeInventoryReport({ issues: [] }).sections.issues, {
    total: 0, knownOwners: 0, unknownOwners: 0, owners: [], domains: {},
  });
});

test("buildAttributionReport produces a deterministic dry-run report envelope", () => {
  const report = buildAttributionReport({ issues: [{ id: "i-1", assigneeAgentId: AGENT_ID, domain: "adm" }] });
  assert.equal(report.schema, ATTRIBUTION_REPORT_SCHEMA);
  assert.equal(report.mode, "dry-run-read-only");
  const again = buildAttributionReport({ issues: [{ id: "i-1", assigneeAgentId: AGENT_ID, domain: "adm" }] });
  assert.deepEqual(again, report);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("value"));
});

// Behavioral coverage: exercise the actual CLI entry point end-to-end.
const SCRIPT_PATH = fileURLToPath(new URL("./company-boundaries-inventory.mjs", import.meta.url));

test("CLI attribution command appends attribution summary to a captured report", () => {
  const dir = mkdtempSync(join(tmpdir(), "cbi-cli-"));
  try {
    const captured = {
      sections: {
        issues: [
          { id: "i-1", title: "top secret title", assigneeAgentId: AGENT_ID, domain: "adm" },
          { id: "i-2", assigneeAgentId: null, metadata: { domain: "NOT-A-DOMAIN" } },
        ],
        secretBindings: [{ id: "s-1", ownerUserId: USER_ID, value: "hunter2" }],
      },
    };
    const reportFile = join(dir, "captured.json");
    const outFile = join(dir, "attribution.json");
    writeFileSync(reportFile, JSON.stringify(captured));
    const run = spawnSync(process.execPath, [SCRIPT_PATH, "attribution", "--report", reportFile, "--out", outFile], { encoding: "utf8" });
    assert.equal(run.status, EXIT_OK, run.stderr);
    const report = JSON.parse(readFileSync(outFile, "utf8"));
    assert.equal(report.schema, ATTRIBUTION_REPORT_SCHEMA);
    assert.equal(report.mode, "dry-run-read-only");
    assert.equal(report.attribution.sections.issues.total, 2);
    assert.deepEqual(report.attribution.sections.issues.domains, { adm: 1, unknown: 1 });
    const serialized = readFileSync(outFile, "utf8");
    assert.ok(!serialized.includes("top secret title"));
    assert.ok(!serialized.includes("hunter2"));
    assert.ok(!serialized.includes("NOT-A-DOMAIN"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI attribution prints to stdout and fails with usage exit on bad input", () => {
  const dir = mkdtempSync(join(tmpdir(), "cbi-cli-"));
  try {
    const reportFile = join(dir, "captured.json");
    writeFileSync(reportFile, JSON.stringify({ issues: [{ id: "i-1", assigneeAgentId: AGENT_ID, domain: "work" }] }));
    const ok = spawnSync(process.execPath, [SCRIPT_PATH, "attribution", "--report", reportFile], { encoding: "utf8" });
    assert.equal(ok.status, EXIT_OK);
    const stdoutReport = JSON.parse(ok.stdout);
    assert.deepEqual(stdoutReport.attribution.sections.issues.domains, { work: 1 });

    const missing = spawnSync(process.execPath, [SCRIPT_PATH, "attribution"], { encoding: "utf8" });
    assert.equal(missing.status, EXIT_USAGE);
    assert.ok(missing.stderr.includes("--report"));

    const unknownCmd = spawnSync(process.execPath, [SCRIPT_PATH, "explode"], { encoding: "utf8" });
    assert.equal(unknownCmd.status, EXIT_USAGE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
