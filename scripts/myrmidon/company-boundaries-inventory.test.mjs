import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyHttpStatus,
  containsPotentialSecret,
  formatInventorySummary,
  inferAgentDomain,
  normalizeInstructionsBundle,
  normalizeSkillsSnapshot,
  parseCliArgs,
  probeCompanyBoundariesInventory,
  PROBE_STATUS,
  redactSecrets,
  sanitizeErrorReason,
  SCHEMA_VERSION,
} from "./company-boundaries-inventory.mjs";

test("redactSecrets sanitizes known credential patterns", () => {
  assert.equal(
    redactSecrets("Bearer pcp_invite_secret_token_12345"),
    "Bearer [REDACTED]",
  );
  assert.equal(
    redactSecrets("Bearer some-token-value-here=="),
    "Bearer [REDACTED]",
  );
  assert.equal(
    redactSecrets("sk-ant-api03-abcdef1234567890"),
    "[REDACTED]",
  );
  assert.equal(
    redactSecrets("ghp_1234567890abcdefghijklmnopqrst"),
    "[REDACTED]",
  );
  assert.equal(
    redactSecrets("https://alice:top_secret_pass@example.com/api"),
    "https://[REDACTED]:[REDACTED]@example.com/api",
  );
  assert.equal(
    redactSecrets("password: supersecret123"),
    "password: [REDACTED]",
  );
});

test("containsPotentialSecret detects raw secrets and passes redacted text", () => {
  assert.equal(containsPotentialSecret("pcp_123456789"), true);
  assert.equal(containsPotentialSecret("sk-123456789012"), true);
  assert.equal(containsPotentialSecret("Bearer abcdef123456"), true);
  assert.equal(containsPotentialSecret("Normal text without secrets"), false);
  assert.equal(containsPotentialSecret("[REDACTED]"), false);
});

test("classifyHttpStatus maps codes to PROBE_STATUS enum", () => {
  assert.equal(classifyHttpStatus(200), PROBE_STATUS.AVAILABLE);
  assert.equal(classifyHttpStatus(403), PROBE_STATUS.FORBIDDEN);
  assert.equal(classifyHttpStatus(404), PROBE_STATUS.NOT_FOUND);
  assert.equal(classifyHttpStatus(500), PROBE_STATUS.UNAVAILABLE);
  assert.equal(classifyHttpStatus(502), PROBE_STATUS.UNAVAILABLE);
  assert.equal(classifyHttpStatus(null), PROBE_STATUS.UNAVAILABLE);
});

test("sanitizeErrorReason extracts concise message and redacts secrets", () => {
  const jsonWithSecret = JSON.stringify({
    error: "Denied token pcp_live_secret123456",
  });
  const reason = sanitizeErrorReason(403, jsonWithSecret, null);
  assert.equal(reason, "Denied token [REDACTED]");
  assert.equal(containsPotentialSecret(reason), false);
});

test("inferAgentDomain extracts domain from agent name, urlKey, metadata or fallback", () => {
  assert.equal(inferAgentDomain({ name: "adm-dev-eng-16", urlKey: "adm-eng" }), "adm");
  assert.equal(inferAgentDomain({ name: "bbq-smoke-test", urlKey: "smoke" }), "bbq");
  assert.equal(inferAgentDomain({ name: "work-planner" }), "work");
  assert.equal(inferAgentDomain({ name: "life-assistant" }), "life");
  assert.equal(inferAgentDomain({ name: "custom-agent", metadata: { domain: "bbq" } }), "bbq");
  assert.equal(inferAgentDomain({ name: "generic-agent" }, "life"), "life");
  assert.equal(inferAgentDomain({ name: "generic-agent", companyId: "c-123" }), "c-123");
});

test("normalizeSkillsSnapshot preserves structure and excludes unexpected content", () => {
  const raw = {
    adapterType: "hermes_gateway",
    supported: true,
    mode: "managed",
    desiredSkills: ["git-commit", "secret-key-pcp_secret123"],
    entries: [
      {
        key: "git-commit",
        runtimeName: "git-commit",
        source: "repo",
        required: true,
        state: "synced",
      },
    ],
    warnings: ["Token Bearer secret12345 was omitted"],
  };

  const normalized = normalizeSkillsSnapshot(raw);
  assert.equal(normalized.supported, true);
  assert.equal(normalized.adapterType, "hermes_gateway");
  assert.equal(normalized.desiredSkills.length, 2);
  assert.equal(containsPotentialSecret(JSON.stringify(normalized)), false);
});

test("normalizeInstructionsBundle preserves metadata and excludes file contents", () => {
  const raw = {
    mode: "managed",
    entryFile: "AGENTS.md",
    rootPath: "/var/run/agents/123/instructions",
    editable: true,
    files: [
      {
        path: "AGENTS.md",
        size: 1540,
        language: "markdown",
        markdown: true,
        isEntryFile: true,
        editable: true,
      },
      {
        path: "notes.txt",
        size: 320,
        language: "text",
        markdown: false,
        isEntryFile: false,
        editable: true,
      },
    ],
  };

  const normalized = normalizeInstructionsBundle(raw);
  assert.equal(normalized.mode, "managed");
  assert.equal(normalized.entryFile, "AGENTS.md");
  assert.equal(normalized.files.length, 2);
  assert.equal(normalized.files[0].path, "AGENTS.md");
  assert.equal(normalized.files[0].size, 1540);
  // Verify no file body or content properties exist
  assert.equal(Object.prototype.hasOwnProperty.call(normalized.files[0], "content"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized.files[0], "body"), false);
});

test("probeCompanyBoundariesInventory: complete coverage when all sources 200", async () => {
  const mockFetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/api/companies/comp-1/agents") {
      return {
        status: 200,
        json: async () => [
          {
            id: "agent-adm-1",
            name: "adm-dev-eng-16",
            companyId: "comp-1",
            role: "engineer",
            status: "running",
            adapterType: "hermes_gateway",
          },
          {
            id: "agent-bbq-1",
            name: "bbq-smoke-tester",
            companyId: "comp-1",
            role: "qa",
            status: "idle",
            adapterType: "hermes_gateway",
          },
        ],
      };
    }
    if (u.pathname === "/api/agents/agent-adm-1/skills") {
      return {
        status: 200,
        json: async () => ({
          adapterType: "hermes_gateway",
          supported: true,
          desiredSkills: ["git-review"],
          entries: [{ key: "git-review", runtimeName: "git-review" }],
          warnings: [],
        }),
      };
    }
    if (u.pathname === "/api/agents/agent-bbq-1/skills") {
      return {
        status: 200,
        json: async () => ({
          adapterType: "hermes_gateway",
          supported: true,
          desiredSkills: ["smoke-tests"],
          entries: [{ key: "smoke-tests", runtimeName: "smoke-tests" }],
          warnings: [],
        }),
      };
    }
    if (u.pathname.includes("/instructions-bundle")) {
      return {
        status: 200,
        json: async () => ({
          mode: "managed",
          entryFile: "AGENTS.md",
          rootPath: "/instructions",
          editable: true,
          files: [{ path: "AGENTS.md", size: 500, markdown: true, isEntryFile: true }],
          warnings: [],
        }),
      };
    }
    return { status: 404, json: async () => ({ error: "Not found" }) };
  };

  const inventory = await probeCompanyBoundariesInventory({
    companyId: "comp-1",
    apiUrl: "http://test-server",
    fetchImpl: mockFetch,
    now: new Date("2026-11-12T12:00:00Z"),
  });

  assert.equal(inventory.schemaVersion, SCHEMA_VERSION);
  assert.equal(inventory.companyId, "comp-1");
  assert.equal(inventory.coverage.status, "complete");
  assert.equal(inventory.coverage.complete, true);
  assert.equal(inventory.coverage.agentsTotal, 2);
  assert.equal(inventory.coverage.missingSources.length, 0);
  assert.equal(inventory.coverage.skills.available, 2);
  assert.equal(inventory.coverage.instructions.available, 2);

  assert.ok(inventory.byDomain.adm);
  assert.equal(inventory.byDomain.adm.agentsTotal, 1);
  assert.equal(inventory.byDomain.adm.skillsAvailable, 1);
  assert.equal(inventory.byDomain.adm.instructionsAvailable, 1);
  assert.ok(inventory.byDomain.bbq);
  assert.equal(inventory.byDomain.bbq.agentsTotal, 1);
  assert.equal(inventory.byDomain.bbq.skillsAvailable, 1);
  assert.equal(inventory.byDomain.bbq.instructionsAvailable, 1);

  assert.equal(typeof inventory.probeDigest, "string");
  assert.equal(inventory.probeDigest.length, 64);
});

test("probeCompanyBoundariesInventory: missing source / 403 / 404 displays as incomplete coverage, not empty", async () => {
  const mockFetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/api/companies/comp-1/agents") {
      return {
        status: 200,
        json: async () => [
          {
            id: "agent-1",
            name: "adm-lead",
            companyId: "comp-1",
            adapterType: "hermes_gateway",
          },
          {
            id: "agent-2",
            name: "work-reporter",
            companyId: "comp-1",
            adapterType: "omp_local",
          },
        ],
      };
    }
    if (u.pathname === "/api/agents/agent-1/skills") {
      // 403 Forbidden (missing grant)
      return {
        status: 403,
        json: async () => ({
          error: "Missing permission: agents:suggest-changes",
          details: { reason: "deny_missing_grant" },
        }),
      };
    }
    if (u.pathname === "/api/agents/agent-1/instructions-bundle") {
      return {
        status: 200,
        json: async () => ({
          mode: "managed",
          entryFile: "AGENTS.md",
          files: [{ path: "AGENTS.md", size: 200 }],
        }),
      };
    }
    if (u.pathname === "/api/agents/agent-2/skills") {
      return {
        status: 200,
        json: async () => ({
          adapterType: "omp_local",
          supported: false,
          desiredSkills: [],
          entries: [],
        }),
      };
    }
    if (u.pathname === "/api/agents/agent-2/instructions-bundle") {
      // 404 Not found
      return {
        status: 404,
        json: async () => ({ error: "Agent not found" }),
      };
    }
    return { status: 500, json: async () => ({ error: "Internal error" }) };
  };

  const inventory = await probeCompanyBoundariesInventory({
    companyId: "comp-1",
    apiUrl: "http://test-server",
    fetchImpl: mockFetch,
    now: new Date("2026-11-12T12:00:00Z"),
  });

  // Verify it is NOT reported as empty or silent
  assert.equal(inventory.coverage.status, "incomplete");
  assert.equal(inventory.coverage.complete, false);
  assert.equal(inventory.coverage.agentsTotal, 2);
  assert.equal(inventory.coverage.agentsProbed, 2);

  // Missing sources recorded
  assert.equal(inventory.coverage.missingSources.length, 2);

  const skillGap = inventory.coverage.missingSources.find((g) => g.source === "skills");
  assert.ok(skillGap);
  assert.equal(skillGap.agentId, "agent-1");
  assert.equal(skillGap.status, PROBE_STATUS.FORBIDDEN);
  assert.equal(skillGap.httpStatus, 403);
  assert.equal(skillGap.reason, "Missing permission: agents:suggest-changes");

  const instrGap = inventory.coverage.missingSources.find((g) => g.source === "instructions");
  assert.ok(instrGap);
  assert.equal(instrGap.agentId, "agent-2");
  assert.equal(instrGap.status, PROBE_STATUS.NOT_FOUND);
  assert.equal(instrGap.httpStatus, 404);

  // Counters reflect partial results
  assert.equal(inventory.coverage.skills.forbidden, 1);
  assert.equal(inventory.coverage.skills.available, 1);
  assert.equal(inventory.coverage.instructions.notFound, 1);
  assert.equal(inventory.coverage.instructions.available, 1);

  // Domains show incomplete counters
  assert.equal(inventory.byDomain.adm.skillsIncomplete, 1);
  assert.equal(inventory.byDomain.adm.instructionsAvailable, 1);
  assert.equal(inventory.byDomain.work.skillsAvailable, 1);
  assert.equal(inventory.byDomain.work.instructionsIncomplete, 1);
});

test("probeCompanyBoundariesInventory: failure to fetch agents list records incomplete coverage", async () => {
  const mockFetch = async () => ({
    status: 403,
    json: async () => ({ error: "Access denied to company" }),
  });

  const inventory = await probeCompanyBoundariesInventory({
    companyId: "comp-secret",
    apiUrl: "http://test-server",
    fetchImpl: mockFetch,
  });

  assert.equal(inventory.coverage.status, "unavailable");
  assert.equal(inventory.coverage.complete, false);
  assert.equal(inventory.coverage.agentsListStatus, PROBE_STATUS.FORBIDDEN);
  assert.equal(inventory.coverage.agentsListHttpStatus, 403);
  assert.equal(inventory.coverage.missingSources.length, 1);
  assert.equal(inventory.coverage.missingSources[0].source, "agents");
  assert.equal(inventory.coverage.missingSources[0].status, PROBE_STATUS.FORBIDDEN);
});

test("probeCompanyBoundariesInventory: redaction guarantees no secrets are exported", async () => {
  const mockFetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.includes("/agents")) {
      return {
        status: 200,
        json: async () => [
          {
            id: "agent-1",
            name: "adm-bot with pcp_secret_leak_12345",
            companyId: "comp-1",
            domain: "adm",
            urlKey: "adm-pcp_aaaaaaaaaa",
          },
        ],
      };
    }
    if (u.pathname.includes("/skills")) {
      return {
        status: 200,
        json: async () => ({
          adapterType: "hermes_gateway",
          supported: true,
          desiredSkills: ["pcp_token_leak", "safe-skill"],
          entries: [
            {
              key: "safe-skill",
              detail: "password: supersecretpassword123",
            },
          ],
          warnings: ["Bearer sensitive-bearer-token-12345=="],
        }),
      };
    }
    if (u.pathname.includes("/instructions-bundle")) {
      return {
        status: 200,
        json: async () => ({
          mode: "managed",
          rootPath: "/var/secret/ghp_1234567890abcdefghijklmnopqrst",
          entryFile: "AGENTS.md",
          files: [
            {
              path: "config/pcp_secret.key",
              size: 100,
            },
          ],
          warnings: [],
        }),
      };
    }
  };

  const inventory = await probeCompanyBoundariesInventory({
    companyId: "comp-1",
    apiUrl: "http://test-server",
    fetchImpl: mockFetch,
  });

  const serialized = JSON.stringify(inventory);
  assert.equal(containsPotentialSecret(serialized), false, "Output must contain no secrets");
  assert.ok(serialized.includes("[REDACTED]"));
});

test("probeCompanyBoundariesInventory: repeat probe is stable and deterministic", async () => {
  const mockAgents = [
    { id: "agent-z", name: "adm-z" },
    { id: "agent-a", name: "bbq-a" },
    { id: "agent-m", name: "work-m" },
  ];

  const createMockFetch = () => async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/agents")) {
      // Intentionally return unordered
      return { status: 200, json: async () => [...mockAgents] };
    }
    if (u.pathname.includes("/skills")) {
      return {
        status: 200,
        json: async () => ({
          adapterType: "hermes_gateway",
          supported: true,
          desiredSkills: ["skill-b", "skill-a"],
          entries: [{ key: "skill-b" }, { key: "skill-a" }],
        }),
      };
    }
    return {
      status: 200,
      json: async () => ({
        mode: "managed",
        entryFile: "AGENTS.md",
        files: [{ path: "z.md" }, { path: "a.md" }],
      }),
    };
  };

  const inventory1 = await probeCompanyBoundariesInventory({
    companyId: "comp-1",
    apiUrl: "http://test-server",
    fetchImpl: createMockFetch(),
  });

  const inventory2 = await probeCompanyBoundariesInventory({
    companyId: "comp-1",
    apiUrl: "http://test-server",
    fetchImpl: createMockFetch(),
  });

  // Verify agents order is stably sorted by ID
  assert.deepEqual(
    inventory1.agents.map((a) => a.agentId),
    ["agent-a", "agent-m", "agent-z"],
  );
  assert.deepEqual(
    inventory2.agents.map((a) => a.agentId),
    ["agent-a", "agent-m", "agent-z"],
  );

  // Files in instructions are stably sorted
  assert.deepEqual(
    inventory1.agents[0].instructions.bundle.files.map((f) => f.path),
    ["a.md", "z.md"],
  );

  // Desired skills and entries are stably sorted
  assert.deepEqual(inventory1.agents[0].skills.snapshot.desiredSkills, ["skill-a", "skill-b"]);

  // Probe digests must match exactly
  assert.equal(inventory1.probeDigest, inventory2.probeDigest);
});

test("formatInventorySummary formats readable report", () => {
  const mockInventory = {
    schemaVersion: "1.0.0",
    companyId: "comp-123",
    probeDigest: "abcdef0123456789",
    coverage: {
      status: "incomplete",
      complete: false,
      agentsListStatus: "available",
      agentsTotal: 2,
      agentsProbed: 2,
      skills: { available: 1, forbidden: 1, notFound: 0, unavailable: 0 },
      instructions: { available: 2, forbidden: 0, notFound: 0, unavailable: 0 },
      missingSources: [
        {
          agentId: "agent-1",
          agentName: "adm-eng",
          source: "skills",
          status: "forbidden",
          httpStatus: 403,
          reason: "Missing permission",
        },
      ],
    },
    byDomain: {
      adm: {
        agentsTotal: 1,
        skillsAvailable: 0,
        skillEntriesCount: 0,
        instructionsAvailable: 1,
        instructionFilesCount: 1,
      },
    },
  };

  const formatted = formatInventorySummary(mockInventory);
  assert.ok(formatted.includes("Company: comp-123"));
  assert.ok(formatted.includes("Coverage: incomplete"));
  assert.ok(formatted.includes("forbidden=1"));
  assert.ok(formatted.includes("Missing permission"));
});

test("parseCliArgs parses flags and environment variables", () => {
  const opts = parseCliArgs([
    "--company-id",
    "c-456",
    "--api-url",
    "http://board:3100",
    "--json",
    "--fail-on-incomplete",
    "--domain",
    "bbq",
    "--agent-id",
    "a-1,a-2",
  ]);

  assert.equal(opts.companyId, "c-456");
  assert.equal(opts.apiUrl, "http://board:3100");
  assert.equal(opts.json, true);
  assert.equal(opts.failOnIncomplete, true);
  assert.equal(opts.domain, "bbq");
  assert.deepEqual(opts.agentIds, ["a-1", "a-2"]);
});
