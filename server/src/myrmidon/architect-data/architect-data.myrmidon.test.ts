// server/src/myrmidon/architect-data/architect-data.myrmidon.test.ts
//
// myrmidon(1.6.6 ARCH-DATA): test suite for architect operational data
// access, secret scrubbing, RBAC, REST endpoints, and MCP server tools.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import {
  ARCHITECT_DATA_API_BASE,
  ARCHITECT_DATA_MCP_PATH,
  ARCHITECT_MCP_TOOLS,
  scrubSecrets,
} from "@myrmidon/shared";
import { errorHandler } from "../../middleware/index.js";
import {
  myrmidonArchitectDataMcpRoutes,
  myrmidonArchitectDataRoutes,
} from "./index.js";
import {
  getChatgptPoolData,
  getHermesCompressionEvents,
} from "./service.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ARCHITECT_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ENGINEER_AGENT_ID = "33333333-3333-4333-8333-333333333333";

const boardActor = {
  type: "board",
  source: "session",
  userId: "user-board",
  companyIds: [COMPANY_ID],
};

const instanceAdminActor = {
  type: "board",
  source: "local_implicit",
  isInstanceAdmin: true,
  userId: "user-admin",
  companyIds: [COMPANY_ID],
};

const architectActor = {
  type: "agent",
  agentId: ARCHITECT_AGENT_ID,
  companyIds: [COMPANY_ID],
};

const engineerActor = {
  type: "agent",
  agentId: ENGINEER_AGENT_ID,
  companyIds: [COMPANY_ID],
};

/** Create a mock DB returning test rows */
function createMockDb(): Db {
  return {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: (n: number) => {
            // Check if querying agents table
            return Promise.resolve([
              {
                id: ARCHITECT_AGENT_ID,
                name: "adm-architect",
                role: "architect",
                companyId: COMPANY_ID,
              },
            ]);
          },
          orderBy: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    }),
  } as unknown as Db;
}

function harness(actor: unknown, db: Db = createMockDb(), options = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", myrmidonArchitectDataRoutes(db, options));
  app.use("/api", myrmidonArchitectDataMcpRoutes(db, options));
  app.use(errorHandler);
  return app;
}

describe("ARCH-DATA: secret scrubbing", () => {
  it("scrubs Bearer tokens, API keys, passwords, and pcp tokens", () => {
    const raw =
      "Error: auth failed for Bearer pcp_live_secret1234567890 with sk-12345678901234567890 and password=mySecretPassword123";
    const cleaned = scrubSecrets(raw);
    expect(cleaned).not.toContain("pcp_live_secret1234567890");
    expect(cleaned).not.toContain("sk-12345678901234567890");
    expect(cleaned).not.toContain("mySecretPassword123");
    expect(cleaned).toContain("[REDACTED]");
  });
});

describe("ARCH-DATA: RBAC authorization", () => {
  const url = `/api/myrmidon/companies/${COMPANY_ID}/architect-data/bundle`;

  it("rejects ordinary board user without architect grant or instance admin with 403", async () => {
    const app = harness(boardActor);
    const res = await request(app).get(url).expect(403);
    expect(res.body.error).toMatch(/Architect data access restricted/);
  });

  it("permits instance admin access", async () => {
    const app = harness(instanceAdminActor);
    const res = await request(app).get(url).expect(200);
    expect(res.body).toHaveProperty("compressionEvents");
    expect(res.body).toHaveProperty("chatgptPool");
    expect(res.body).toHaveProperty("llmCalls");
    expect(res.body).toHaveProperty("heartbeatRuns");
  });

  it("permits architect agent role access", async () => {
    const app = harness(architectActor);
    const res = await request(app).get(url).expect(200);
    expect(res.body).toHaveProperty("collectedAt");
  });

  it("rejects unauthorized agent role with 403", async () => {
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                {
                  id: ENGINEER_AGENT_ID,
                  name: "adm-dev-eng-8",
                  role: "engineer",
                  companyId: COMPANY_ID,
                },
              ]),
          }),
        }),
      }),
    } as unknown as Db;

    const app = harness(engineerActor, mockDb);
    const res = await request(app).get(url).expect(403);
    expect(res.body.error).toContain("Architect data access restricted");
  });
});

describe("ARCH-DATA: MCP JSON-RPC protocol endpoint", () => {
  const mcpUrl = `/api/myrmidon/companies/${COMPANY_ID}/architect-data/mcp`;

  it("answers initialize with server identity and capabilities", async () => {
    const app = harness(architectActor);
    const res = await request(app)
      .post(mcpUrl)
      .send({ jsonrpc: "2.0", id: 1, method: "initialize" })
      .expect(200);

    expect(res.body.result.serverInfo.name).toBe("myrmidon-architect-data");
    expect(res.body.result.capabilities.tools).toBeDefined();
  });

  it("answers tools/list with all 5 operational metrics tools", async () => {
    const app = harness(architectActor);
    const res = await request(app)
      .post(mcpUrl)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
      .expect(200);

    const toolNames = res.body.result.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain(ARCHITECT_MCP_TOOLS.GET_COMPRESSION_EVENTS);
    expect(toolNames).toContain(ARCHITECT_MCP_TOOLS.GET_CHATGPT_LIMITS);
    expect(toolNames).toContain(ARCHITECT_MCP_TOOLS.GET_LLM_CALLS);
    expect(toolNames).toContain(ARCHITECT_MCP_TOOLS.GET_HEARTBEAT_RUNS);
    expect(toolNames).toContain(ARCHITECT_MCP_TOOLS.GET_DATA_BUNDLE);
  });

  it("executes tools/call for architect_get_data_bundle", async () => {
    const app = harness(architectActor);
    const res = await request(app)
      .post(mcpUrl)
      .send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: ARCHITECT_MCP_TOOLS.GET_DATA_BUNDLE,
          arguments: { hours: 48, limit: 50 },
        },
      })
      .expect(200);

    expect(res.body.result.content[0].type).toBe("text");
    const parsed = JSON.parse(res.body.result.content[0].text);
    expect(parsed).toHaveProperty("compressionEvents");
    expect(parsed).toHaveProperty("chatgptPool");
  });
});

describe("ARCH-DATA: ChatGPT pool sqlite reader", () => {
  it("reads limits and reqs from an active usage.db", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-run-chatgpt-test-"));
    const dbFile = path.join(tmpDir, "usage.db");

    const sqlite = new DatabaseSync(dbFile);
    sqlite.exec(
      "CREATE TABLE limits (acc TEXT, ts INTEGER, plan TEXT, active_limit INTEGER, p_used INTEGER, p_window_min INTEGER, p_reset_at INTEGER, s_used INTEGER, s_window_min INTEGER, s_reset_at INTEGER)",
    );
    sqlite.exec(
      "INSERT INTO limits VALUES ('account-1', 1700000000, 'team', 100, 20, 60, 1700003600, 5, 60, 1700003600)",
    );
    sqlite.exec(
      "CREATE TABLE req (id INTEGER PRIMARY KEY, acc TEXT, ts INTEGER, model TEXT, status INTEGER)",
    );
    const nowSec = Math.floor(Date.now() / 1000);
    sqlite.exec(
      `INSERT INTO req VALUES (1, 'account-1', ${nowSec - 100}, 'gpt-4o', 200)`,
    );
    sqlite.close();

    const result = await getChatgptPoolData({ hours: 48, limit: 10, dbPath: dbFile });
    expect(result.limits.length).toBe(1);
    expect(result.limits[0].acc).toBe("account-1");
    expect(result.limits[0].plan).toBe("team");
    expect(result.reqs.length).toBe(1);
    expect(result.reqs[0].model).toBe("gpt-4o");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles non-existent usage.db cleanly", async () => {
    const result = await getChatgptPoolData({ dbPath: "/non/existent/path/usage.db" });
    expect(result.limits).toEqual([]);
    expect(result.reqs).toEqual([]);
  });
});

describe("ARCH-DATA: Hermes context compression reader", () => {
  it("scans agent log files and extracts compression events", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-run-hermes-test-"));
    const agentDir = path.join(tmpDir, "bot-alpha", "hermes", "logs");
    fs.mkdirSync(agentDir, { recursive: true });

    const logContent = [
      "2026-10-30T10:00:00.000Z Normal log message",
      "2026-10-30T10:01:00.000Z Context compression triggered: 12000 tokens compacted to 4000 Bearer secret_token_12345",
      "2026-10-30T10:02:00.000Z Another standard message",
    ].join("\n");

    fs.writeFileSync(path.join(agentDir, "agent.log"), logContent, "utf-8");

    const mockDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              { id: "bot-alpha", name: "bot-alpha", role: "engineer" },
            ]),
        }),
      }),
    } as unknown as Db;

    const events = await getHermesCompressionEvents(mockDb, COMPANY_ID, {
      botVolumeRoot: tmpDir,
    });

    expect(events.length).toBe(1);
    expect(events[0].agent).toBe("bot-alpha");
    expect(events[0].line).toContain("Context compression triggered");
    expect(events[0].line).not.toContain("secret_token_12345");
    expect(events[0].line).toContain("[REDACTED]");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
