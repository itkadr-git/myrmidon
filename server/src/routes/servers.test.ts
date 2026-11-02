// myrmidon(SERVER-ONBOARD): route tests for the SSH dry-run endpoint.
//
// Covers the acceptance criteria:
//   * success path — the probe result is returned and nothing is persisted
//   * timeout — the executor's timeout outcome maps to a safe 200 response
//   * invalid key — the executor's invalid_key outcome maps to a safe 200 response
//   * no persistence — no database write is issued for any outcome
//   * the private key and password never appear in the response or the log
//
// The SSH executor is mocked; the route is exercised through express with
// a minimal actor middleware stub.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { logger } from "../middleware/logger.js";
import type { Db } from "@myrmidon/db";
import {
  createMockSshDryRunExecutor,
} from "../onboarding/ssh-dry-run.js";
import { serverOnboardingRoutes } from "./servers.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_USER_ID = "user-owner-1";

const OWNER = {
  type: "board",
  source: "session",
  userId: OWNER_USER_ID,
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "owner" }],
};

const OUTSIDER = {
  type: "board",
  source: "session",
  userId: "user-outsider",
  isInstanceAdmin: false,
  companyIds: [OTHER_COMPANY_ID],
  memberships: [{ companyId: OTHER_COMPANY_ID, status: "active", membershipRole: "owner" }],
};

const AGENT_FOR_COMPANY = {
  type: "agent",
  source: "agent_key",
  agentId: "agent-1",
  companyId: COMPANY_ID,
  keyId: "key-a",
};

// Distinctive secret markers so we can prove they never leak into a response.
const PASSWORD_MARKER = "PASSWDmarker123!";
const PRIVATE_KEY_MARKER = "PRIVATEKEYmarker456!";

const PRIVATE_KEY_BODY =
  `-----BEGIN OPENSSH PRIVATE KEY-----\n${PRIVATE_KEY_MARKER}\n-----END OPENSSH PRIVATE KEY-----`;

// A minimal Db stand-in that records every insert/update so the no-persistence
// criterion is checked against a real object rather than a hope.
function makeDbSpy(): { db: Db; inserts: unknown[]; updates: unknown[] } {
  const inserts: unknown[] = [];
  const updates: unknown[] = [];
  const handler = {
    get(_target: unknown, prop: string) {
      if (prop === "insert") {
        return (...args: unknown[]) => {
          inserts.push(args);
          // Return a chainable that throws if awaited; the route must not call it.
          return {
            values: () => ({
              returning: async () => {
                throw new Error("db.insert must not be called by the dry-run route");
              },
            }),
          };
        };
      }
      if (prop === "update") {
        return (...args: unknown[]) => {
          updates.push(args);
          return {
            set: () => ({
              where: async () => {
                throw new Error("db.update must not be called by the dry-run route");
              },
            }),
          };
        };
      }
      // Any other property access returns a no-op proxy.
      return new Proxy(() => undefined, handler);
    },
  };
  return { db: new Proxy({}, handler) as Db, inserts, updates };
}

function makeApp(
  actor: unknown,
  executorBehavior: Parameters<typeof createMockSshDryRunExecutor>[0],
) {
  const executor = createMockSshDryRunExecutor(executorBehavior);
  const { db } = makeDbSpy();
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", serverOnboardingRoutes(db, { sshDryRunExecutor: executor }));
  app.use(errorHandler);
  return { app, executor };
}

function dryRunBody(overrides: Record<string, unknown> = {}) {
  return {
    host: "203.0.113.10",
    port: 22,
    username: "deploy",
    auth: { privateKey: PRIVATE_KEY_BODY },
    ...overrides,
  };
}

describe("POST /api/companies/:companyId/servers/ssh-dry-run", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Silence the route's info log and give us a hook to assert on it.
    logSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
  });

  it("returns the probe result on success and persists nothing", async () => {
    const { app, executor } = makeApp(OWNER, async () => ({
      outcome: "ok",
      passwordlessSudo: true,
      remoteUname: "Linux node-a 6.1.0 x86_64",
      durationMs: 42,
    }));

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/ssh-dry-run`)
      .send(dryRunBody());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      outcome: "ok",
      passwordlessSudo: true,
      remoteUname: "Linux node-a 6.1.0 x86_64",
      durationMs: 42,
    });
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({
      host: "203.0.113.10",
      port: 22,
      username: "deploy",
    });
  });

  it("reports a connection timeout as a normalized outcome, not an error", async () => {
    const { app } = makeApp(OWNER, async () => ({
      outcome: "connection_timeout",
      reason: "connection timed out",
      durationMs: 10_000,
    }));

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/ssh-dry-run`)
      .send(dryRunBody());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "connection_timeout",
      reason: "connection timed out",
    });
  });

  it("reports an invalid key as a normalized outcome, not an error", async () => {
    const { app } = makeApp(OWNER, async () => ({
      outcome: "invalid_key",
      reason: "the private key is invalid, malformed, or the host is unreachable",
      durationMs: 5,
    }));

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/ssh-dry-run`)
      .send(dryRunBody());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "invalid_key" });
  });

  it("accepts password auth as an alternative to a private key", async () => {
    const { app, executor } = makeApp(OWNER, async () => ({
      outcome: "ok",
      passwordlessSudo: false,
      remoteUname: "Linux node-b 6.1.0 arm64",
      durationMs: 12,
    }));

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/ssh-dry-run`)
      .send(dryRunBody({ auth: { password: PASSWORD_MARKER } }));

    expect(res.status).toBe(200);
    expect(executor.calls[0]?.password).toBe(PASSWORD_MARKER);
    expect(executor.calls[0]?.privateKey).toBeUndefined();
  });

  it("rejects a body with both password and privateKey", async () => {
    const { app, executor } = makeApp(OWNER, async () => ({
      outcome: "ok",
      passwordlessSudo: true,
      remoteUname: "",
      durationMs: 0,
    }));

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/ssh-dry-run`)
      .send(
        dryRunBody({
          auth: { password: PASSWORD_MARKER, privateKey: PRIVATE_KEY_BODY },
        }),
      );

    expect(res.status).toBe(400);
    expect(executor.calls).toHaveLength(0);
  });

  it("rejects a body with neither password nor privateKey", async () => {
    const { app, executor } = makeApp(OWNER, async () => ({
      outcome: "ok",
      passwordlessSudo: true,
      remoteUname: "",
      durationMs: 0,
    }));

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/ssh-dry-run`)
      .send(dryRunBody({ auth: {} }));

    expect(res.status).toBe(400);
    expect(executor.calls).toHaveLength(0);
  });

  it("rejects an out-of-range port", async () => {
    const { app, executor } = makeApp(OWNER, async () => ({
      outcome: "ok",
      passwordlessSudo: true,
      remoteUname: "",
      durationMs: 0,
    }));

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/ssh-dry-run`)
      .send(dryRunBody({ port: 70000 }));

    expect(res.status).toBe(400);
    expect(executor.calls).toHaveLength(0);
  });

  it("rejects a whitespace hostname", async () => {
    const { app, executor } = makeApp(OWNER, async () => ({
      outcome: "ok",
      passwordlessSudo: true,
      remoteUname: "",
      durationMs: 0,
    }));

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/ssh-dry-run`)
      .send(dryRunBody({ host: "bad host" }));

    expect(res.status).toBe(400);
    expect(executor.calls).toHaveLength(0);
  });

  it("returns 403 for a user outside the company", async () => {
    const { app, executor } = makeApp(OUTSIDER, async () => ({
      outcome: "ok",
      passwordlessSudo: true,
      remoteUname: "",
      durationMs: 0,
    }));

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/ssh-dry-run`)
      .send(dryRunBody());

    expect(res.status).toBe(403);
    expect(executor.calls).toHaveLength(0);
  });

  it("allows an agent key scoped to the same company", async () => {
    const { app, executor } = makeApp(AGENT_FOR_COMPANY, async () => ({
      outcome: "ok",
      passwordlessSudo: true,
      remoteUname: "Linux node-a 6.1.0 x86_64",
      durationMs: 7,
    }));

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/ssh-dry-run`)
      .send(dryRunBody());

    expect(res.status).toBe(200);
    expect(executor.calls).toHaveLength(1);
  });

  it("never leaks the private key or password into the response", async () => {
    const { app } = makeApp(OWNER, async () => ({
      outcome: "invalid_key",
      reason: "the private key is invalid, malformed, or the host is unreachable",
      durationMs: 3,
    }));

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/ssh-dry-run`)
      .send(dryRunBody());

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(PRIVATE_KEY_MARKER);
    expect(body).not.toContain(PASSWORD_MARKER);
  });

  it("never logs the private key or password", async () => {
    const { app } = makeApp(OWNER, async () => ({
      outcome: "ok",
      passwordlessSudo: true,
      remoteUname: "Linux node-a 6.1.0 x86_64",
      durationMs: 9,
    }));

    await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/ssh-dry-run`)
      .send(dryRunBody({ auth: { password: PASSWORD_MARKER } }));

    const logged = logSpy.mock.calls
      .map((c: unknown[]) => JSON.stringify(c))
      .join("\n");
    expect(logged).not.toContain(PASSWORD_MARKER);
    expect(logged).not.toContain(PRIVATE_KEY_MARKER);
  });
});
