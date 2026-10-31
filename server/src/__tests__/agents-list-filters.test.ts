import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentListItem } from "@myrmidon/shared";
import {
  filterAgentListItems,
  normalizeAgentListFilters,
} from "../services/agents-filters.js";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(),
  createAgentRegistry: vi.fn(),
  createRuntimeStore: vi.fn(),
  isAcpRuntimeError: vi.fn(() => false),
}));

const companyId = "33333333-3333-4333-8333-333333333333";

function makeAgent(overrides: Partial<AgentListItem>): AgentListItem {
  return {
    id: "default-agent-id",
    companyId,
    name: "Default Agent",
    urlKey: "default-agent",
    role: "engineer",
    title: "Software Engineer",
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterModel: "claude-sonnet-4-5",
    projectIds: [],
    runtimeConfig: null,
    defaultEnvironmentId: null,
    budgetMonthlyCents: null,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    errorReason: null,
    permissions: null,
    lastHeartbeatAt: null,
    metadata: null,
    orgChainHealth: {
      isEligible: true,
      isIncomplete: false,
      reason: null,
      missingManagerId: null,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// 5-agent fixture spanning distinct roles, statuses, reportsTo hierarchy, names, and titles
const fixtureAgents: AgentListItem[] = [
  makeAgent({
    id: "agent-1",
    name: "Alice Architect",
    role: "architect",
    title: "Chief System Architect",
    status: "running",
    reportsTo: null,
  }),
  makeAgent({
    id: "agent-2",
    name: "Bob Builder",
    role: "engineer",
    title: "Senior Backend Engineer",
    status: "idle",
    reportsTo: "agent-1",
  }),
  makeAgent({
    id: "agent-3",
    name: "Charlie Checker",
    role: "qa",
    title: "Staff QA Engineer",
    status: "idle",
    reportsTo: "agent-1",
  }),
  makeAgent({
    id: "agent-4",
    name: "Dave Defender",
    role: "security",
    title: "Lead Security Auditor",
    status: "paused",
    reportsTo: "agent-2",
  }),
  makeAgent({
    id: "agent-5",
    name: "Eve Operations",
    role: "devops",
    title: "Principal Site Reliability Engineer",
    status: "error",
    reportsTo: null,
  }),
];

describe("normalizeAgentListFilters", () => {
  it("returns null when no filters are provided or all fields are empty", () => {
    expect(normalizeAgentListFilters()).toBeNull();
    expect(normalizeAgentListFilters(null)).toBeNull();
    expect(normalizeAgentListFilters({})).toBeNull();
    expect(normalizeAgentListFilters({ q: "   ", role: "", reportsTo: "  " })).toBeNull();
    expect(normalizeAgentListFilters({ status: "" })).toBeNull();
    expect(normalizeAgentListFilters({ status: ["", "  "] })).toBeNull();
  });

  it("normalizes q by trimming and lowercasing", () => {
    expect(normalizeAgentListFilters({ q: "  Architect  " })).toEqual({
      q: "architect",
    });
  });

  it("normalizes status from single string, comma-separated string, or array", () => {
    expect(normalizeAgentListFilters({ status: "idle" })).toEqual({
      statuses: ["idle"],
    });
    expect(normalizeAgentListFilters({ status: "running, idle, PAUSED" })).toEqual({
      statuses: ["idle", "paused", "running"],
    });
    expect(normalizeAgentListFilters({ status: ["error", "RUNNING"] })).toEqual({
      statuses: ["error", "running"],
    });
  });

  it("normalizes role and reportsTo", () => {
    expect(normalizeAgentListFilters({ role: " engineer " })).toEqual({
      role: "engineer",
    });
    expect(normalizeAgentListFilters({ reportsTo: " none " })).toEqual({
      reportsTo: "none",
    });
    expect(normalizeAgentListFilters({ reportsTo: "agent-1" })).toEqual({
      reportsTo: "agent-1",
    });
  });

  it("normalizes combined filters deterministically", () => {
    const f1 = normalizeAgentListFilters({
      q: "Alice",
      status: "running,idle",
      role: "architect",
      reportsTo: "none",
    });
    const f2 = normalizeAgentListFilters({
      status: ["idle", "running"],
      q: "ALICE",
      reportsTo: "none",
      role: "architect",
    });
    expect(JSON.stringify(f1)).toBe(JSON.stringify(f2));
  });
});

describe("filterAgentListItems with 5-agent fixture", () => {
  it("filters by q independently (substring in name, role, or title, case-insensitive)", () => {
    // name match
    const byName = filterAgentListItems(fixtureAgents, { q: "alice" });
    expect(byName.map((a) => a.id)).toEqual(["agent-1"]);

    // role match
    const byRole = filterAgentListItems(fixtureAgents, { q: "security" });
    expect(byRole.map((a) => a.id)).toEqual(["agent-4"]);

    // title match
    const byTitle = filterAgentListItems(fixtureAgents, { q: "backend" });
    expect(byTitle.map((a) => a.id)).toEqual(["agent-2"]);

    // title/role match spanning multiple agents
    const byEngineer = filterAgentListItems(fixtureAgents, { q: "ENGINEER" });
    // Agent 2 (role: engineer, title: Senior Backend Engineer) and Agent 3 (title: Staff QA Engineer)
    expect(byEngineer.map((a) => a.id)).toEqual(["agent-2", "agent-3"]);
  });

  it("filters by status independently (single or comma-separated)", () => {
    const idleOnly = filterAgentListItems(fixtureAgents, { status: "idle" });
    expect(idleOnly.map((a) => a.id)).toEqual(["agent-2", "agent-3"]);

    const runningOnly = filterAgentListItems(fixtureAgents, { status: "running" });
    expect(runningOnly.map((a) => a.id)).toEqual(["agent-1"]);

    const multiStatus = filterAgentListItems(fixtureAgents, { status: "idle, paused" });
    expect(multiStatus.map((a) => a.id)).toEqual(["agent-2", "agent-3", "agent-4"]);

    const caseInsensitiveStatus = filterAgentListItems(fixtureAgents, { status: "ERROR,RUNNING" });
    expect(caseInsensitiveStatus.map((a) => a.id)).toEqual(["agent-1", "agent-5"]);
  });

  it("filters by role independently", () => {
    const architects = filterAgentListItems(fixtureAgents, { role: "architect" });
    expect(architects.map((a) => a.id)).toEqual(["agent-1"]);

    const engineers = filterAgentListItems(fixtureAgents, { role: "engineer" });
    expect(engineers.map((a) => a.id)).toEqual(["agent-2"]);

    const none = filterAgentListItems(fixtureAgents, { role: "designer" });
    expect(none).toEqual([]);
  });

  it("filters by reportsTo independently (agent id or 'none' for root)", () => {
    // Root agents have reportsTo === null
    const rootAgents = filterAgentListItems(fixtureAgents, { reportsTo: "none" });
    expect(rootAgents.map((a) => a.id)).toEqual(["agent-1", "agent-5"]);

    // Direct reports to agent-1
    const reportsTo1 = filterAgentListItems(fixtureAgents, { reportsTo: "agent-1" });
    expect(reportsTo1.map((a) => a.id)).toEqual(["agent-2", "agent-3"]);

    // Direct reports to agent-2
    const reportsTo2 = filterAgentListItems(fixtureAgents, { reportsTo: "agent-2" });
    expect(reportsTo2.map((a) => a.id)).toEqual(["agent-4"]);
  });

  it("combines all filters together with AND logic", () => {
    // q matches "engineer" (agent-2, agent-3)
    // status matches "idle" (agent-2, agent-3)
    // role matches "engineer" (agent-2)
    // reportsTo matches "agent-1" (agent-2, agent-3)
    const combinedMatch = filterAgentListItems(fixtureAgents, {
      q: "engineer",
      status: "idle",
      role: "engineer",
      reportsTo: "agent-1",
    });
    expect(combinedMatch.map((a) => a.id)).toEqual(["agent-2"]);

    // If one condition fails, result is empty
    const noMatch = filterAgentListItems(fixtureAgents, {
      q: "engineer",
      status: "running", // agent-2 is idle, not running
      role: "engineer",
      reportsTo: "agent-1",
    });
    expect(noMatch).toEqual([]);

    // Match root architect
    const rootArchitect = filterAgentListItems(fixtureAgents, {
      q: "alice",
      status: "running",
      role: "architect",
      reportsTo: "none",
    });
    expect(rootArchitect.map((a) => a.id)).toEqual(["agent-1"]);
  });
});

// Route integration tests
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(async () => ({ allowed: true })),
  canUser: vi.fn(async () => true),
}));

const mockAgentService = vi.hoisted(() => ({
  listSummaries: vi.fn(),
  listSummariesVersionKey: vi.fn(),
  list: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));
  vi.doMock("../services/agents.js", async () => {
    const actual = await vi.importActual<typeof import("../services/agents.js")>("../services/agents.js");
    return {
      ...actual,
      agentService: () => mockAgentService,
    };
  });
  vi.doMock("../services/index.js", async () => {
    const actual = await vi.importActual<typeof import("../services/index.js")>("../services/index.js");
    return {
      ...actual,
      accessService: () => mockAccessService,
      agentService: () => mockAgentService,
    };
  });
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => Promise<request.Response>,
): Promise<request.Response> {
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

describe.sequential("GET /companies/:companyId/agents route filters and ETag", () => {
  const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
    const [{ errorHandler }, { agentRoutes }] = await Promise.all([
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
      vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    ]);
    return { errorHandler, agentRoutes };
  });

  function createApp() {
    const { errorHandler, agentRoutes } = routeModules.value;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-user",
        source: "local_implicit",
        isInstanceAdmin: true,
        companyIds: [companyId],
      };
      next();
    });
    app.use("/api", agentRoutes({} as any, { casteDirectory: {} as any } as any));
    app.use(errorHandler);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true });
    mockAccessService.canUser.mockResolvedValue(true);
    mockAgentService.listSummaries.mockResolvedValue(fixtureAgents);
    mockAgentService.listSummariesVersionKey.mockImplementation(
      async (_companyId: string, _actorShape: string, filterKey?: string | null) => {
        return filterKey
          ? `"vk-agents-list:unfiltered:${filterKey}"`
          : '"vk-agents-list:unfiltered"';
      },
    );
  });

  it("returns 400 for unsupported query parameters", async () => {
    const app = createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyId}/agents?foo=1`),
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Unsupported query parameter: foo" });
  });

  it("returns 400 listing all unsupported query parameters sorted", async () => {
    const app = createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyId}/agents?foo=1&bar=2&q=alice`),
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Unsupported query parameters: bar, foo" });
  });

  it("serves unmodified byte-for-byte regression response without query parameters", async () => {
    const app = createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyId}/agents`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"vk-agents-list:unfiltered"');
    expect(res.body).toEqual(fixtureAgents);
    // svc.listSummariesVersionKey called without filterKey
    expect(mockAgentService.listSummariesVersionKey).toHaveBeenCalledWith(
      companyId,
      expect.any(String),
    );
  });

  it("serves filtered responses for individual query parameters", async () => {
    const app = createApp();

    // q filter
    const resQ = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyId}/agents?q=alice`),
    );
    expect(resQ.status).toBe(200);
    expect(resQ.body.map((a: AgentListItem) => a.id)).toEqual(["agent-1"]);

    // status filter (single)
    const resStatus = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyId}/agents?status=idle`),
    );
    expect(resStatus.status).toBe(200);
    expect(resStatus.body.map((a: AgentListItem) => a.id)).toEqual(["agent-2", "agent-3"]);

    // status filter (comma-separated)
    const resMultiStatus = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyId}/agents?status=idle,paused`),
    );
    expect(resMultiStatus.status).toBe(200);
    expect(resMultiStatus.body.map((a: AgentListItem) => a.id)).toEqual(["agent-2", "agent-3", "agent-4"]);

    // role filter
    const resRole = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyId}/agents?role=architect`),
    );
    expect(resRole.status).toBe(200);
    expect(resRole.body.map((a: AgentListItem) => a.id)).toEqual(["agent-1"]);

    // reportsTo=none
    const resRoot = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyId}/agents?reportsTo=none`),
    );
    expect(resRoot.status).toBe(200);
    expect(resRoot.body.map((a: AgentListItem) => a.id)).toEqual(["agent-1", "agent-5"]);

    // reportsTo=agent-1
    const resReports = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyId}/agents?reportsTo=agent-1`),
    );
    expect(resReports.status).toBe(200);
    expect(resReports.body.map((a: AgentListItem) => a.id)).toEqual(["agent-2", "agent-3"]);
  });

  it("serves combined AND filters on route", async () => {
    const app = createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(
        `/api/companies/${companyId}/agents?q=engineer&status=idle&role=engineer&reportsTo=agent-1`,
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body.map((a: AgentListItem) => a.id)).toEqual(["agent-2"]);
  });

  it("request with filter and ETag from unfiltered request does not return 304", async () => {
    const app = createApp();

    // 1. Unfiltered request gets unfiltered ETag
    const unfilteredRes = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyId}/agents`),
    );
    expect(unfilteredRes.status).toBe(200);
    const unfilteredEtag = unfilteredRes.headers.etag;
    expect(unfilteredEtag).toBe('"vk-agents-list:unfiltered"');

    // 2. Filtered request presenting unfiltered ETag MUST NOT return 304
    const filteredRes = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .get(`/api/companies/${companyId}/agents?status=idle`)
        .set("If-None-Match", unfilteredEtag),
    );
    expect(filteredRes.status).toBe(200);
    expect(filteredRes.headers.etag).not.toBe(unfilteredEtag);
    expect(filteredRes.body.map((a: AgentListItem) => a.id)).toEqual(["agent-2", "agent-3"]);

    // 3. Filtered request with matching filtered ETag DOES return 304
    const filteredEtag = filteredRes.headers.etag;
    const cachedFilteredRes = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .get(`/api/companies/${companyId}/agents?status=idle`)
        .set("If-None-Match", filteredEtag),
    );
    expect(cachedFilteredRes.status).toBe(304);

    // 4. Unfiltered request with matching unfiltered ETag returns 304
    const cachedUnfilteredRes = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .get(`/api/companies/${companyId}/agents`)
        .set("If-None-Match", unfilteredEtag),
    );
    expect(cachedUnfilteredRes.status).toBe(304);
  });
});
