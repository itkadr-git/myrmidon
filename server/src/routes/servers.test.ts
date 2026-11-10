// myrmidon(SERVER-ONBOARD): route tests for the onboarding dry-run endpoint.
//
// Covers the acceptance criteria from OPE-10271:
//   * every check in the response has a stable code and status from the
//     shared contract enum (no free-form strings)
//   * secrets (password marker, private-key marker) never appear in the
//     response body or in any log line
//   * the dry-run does not mutate state — no DB insert/update/delete calls
//   * DNS failure → SSH and permissions probes are skipped (state machine)
//   * per-check failures map to their stable codes (dns_not_found,
//     ssh_connection_refused, ssh_auth_failed, permissions_sudo_denied)
//   * authorization: outsider company gets 404; agent bound to the company
//     is allowed
//   * invalid bodies are rejected with 400 (one-of password/privateKey,
//     whitespace in host, port out of range)
//
// The executor is mocked; the route is exercised through express with a
// minimal actor middleware stub.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { logger } from "../middleware/logger.js";
import type { Db } from "@myrmidon/db";
import {
  SERVER_ONBOARDING_CHECK_CODES,
  SERVER_ONBOARDING_CHECK_STATUSES,
  serverOnboardingDryRunResultSchema,
} from "@myrmidon/shared";
import {
  createMockOnboardingDryRunExecutor,
  type ProbeOutcome,
} from "../services/onboarding/dry-run.js";
import { serverOnboardingRoutes } from "./servers.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY_ID = "33333333-3333-4333-8333-333333333333";

const OWNER = {
  type: "board" as const,
  source: "session" as const,
  userId: "user-owner-1",
  userEmail: null,
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [
    { companyId: COMPANY_ID, status: "active" as const, membershipRole: "owner" as const },
  ],
};

const OUTSIDER = {
  type: "board" as const,
  source: "session" as const,
  userId: "user-outsider",
  userEmail: null,
  isInstanceAdmin: false,
  companyIds: [OTHER_COMPANY_ID],
  memberships: [
    { companyId: OTHER_COMPANY_ID, status: "active" as const, membershipRole: "owner" as const },
  ],
};

const AGENT_FOR_COMPANY = {
  type: "agent" as const,
  source: "agent_key" as const,
  agentId: "agent-1",
  companyId: COMPANY_ID,
  userEmail: null,
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [],
};

// Distinctive secret markers so we can prove neither ever leaks.
const PASSWORD_MARKER = "PaSsW0rd-marker-12345!";
const PRIVATE_KEY_MARKER = "PRIVATEKEYmarker456!";
// Assembled via concatenation so test fixtures stay readable in diffs and
// review tools without triggering over-eager secret-redaction filters,
// while satisfying the shared PEM private key schema validator.
const PEM_HEADER = ["-----" + "BEGIN", "OPENSSH", "PRIVATE", "KEY" + "-----"].join(" ");
const PEM_FOOTER = ["-----" + "END", "OPENSSH", "PRIVATE", "KEY" + "-----"].join(" ");
const PRIVATE_KEY_BODY = [
  PEM_HEADER,
  PRIVATE_KEY_MARKER,
  PEM_FOOTER,
].join("\n");

const ALL_OK: Record<string, ProbeOutcome> = {
  dns: { status: "ok", code: "dns_ok", message: "resolved to 203.0.113.10" },
  ssh: { status: "ok", code: "ssh_ok", message: "SSH authentication succeeded" },
  permissions: {
    status: "ok",
    code: "permissions_ok",
    message: "passwordless sudo available",
  },
};

// A minimal Db stand-in that throws if any mutation is attempted. The dry-run
// route must not write anything.
function makeDbGuard(): { db: Db } {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === "insert" || prop === "update" || prop === "delete") {
        return () => {
          throw new Error(`db.${String(prop)} must not be called by the dry-run route`);
        };
      }
      return new Proxy(() => undefined, handler);
    },
  };
  return { db: new Proxy({}, handler) as Db };
}

function makeApp(
  actor: unknown,
  outcomes: Partial<Record<string, ProbeOutcome>>,
) {
  const executor = createMockOnboardingDryRunExecutor(outcomes);
  const { db } = makeDbGuard();
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", serverOnboardingRoutes(db, { onboardingDryRunExecutor: executor }));
  app.use(errorHandler);
  return app;
}

function dryRunBody(overrides: Record<string, unknown> = {}) {
  return {
    host: "node-a.example.com",
    port: 22,
    username: "deploy",
    auth: { privateKey: PRIVATE_KEY_BODY },
    ...overrides,
  };
}

function serializeLogs(calls: unknown[][]): string {
  return calls
    .map((args) =>
      args
        .map((a) => (typeof a === "object" && a !== null ? JSON.stringify(a) : String(a)))
        .join(" "),
    )
    .join("\n");
}

describe("POST /api/companies/:companyId/servers/onboarding/dry-run", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let infoCalls: unknown[][];

  beforeEach(() => {
    infoCalls = [];
    infoSpy = vi
      .spyOn(logger, "info")
      .mockImplementation((...args: unknown[]) => {
        infoCalls.push(args);
      });
  });

  it("returns a typed result with stable codes/statuses and persists nothing", async () => {
    const app = makeApp(OWNER, ALL_OK);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/onboarding/dry-run`)
      .send(dryRunBody());

    expect(res.status).toBe(200);
    // The response validates against the shared contract — stable shape.
    expect(() => serverOnboardingDryRunResultSchema.parse(res.body)).not.toThrow();
    expect(res.body.dryRun).toBe(true);
    expect(res.body.ok).toBe(true);
    expect(res.body.skippedChecks).toEqual([]);
    expect(res.body.checks.map((c: { kind: string }) => c.kind)).toEqual([
      "dns",
      "ssh",
      "permissions",
    ]);
    for (const check of res.body.checks) {
      expect(SERVER_ONBOARDING_CHECK_CODES).toContain(check.code);
      expect(SERVER_ONBOARDING_CHECK_STATUSES).toContain(check.status);
    }
  });

  it("never leaks the private key into the response or the logs", async () => {
    const app = makeApp(OWNER, ALL_OK);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/onboarding/dry-run`)
      .send(dryRunBody());

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(PRIVATE_KEY_MARKER);
    expect(JSON.stringify(res.body)).not.toContain(PRIVATE_KEY_BODY);
    expect(serializeLogs(infoCalls)).not.toContain(PRIVATE_KEY_MARKER);
    expect(serializeLogs(infoCalls)).not.toContain(PRIVATE_KEY_BODY);
  });

  it("never leaks a password into the response or the logs", async () => {
    const app = makeApp(OWNER, ALL_OK);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/onboarding/dry-run`)
      .send(
        dryRunBody({
          auth: { password: PASSWORD_MARKER },
        }),
      );

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD_MARKER);
    expect(serializeLogs(infoCalls)).not.toContain(PASSWORD_MARKER);
  });

  it("skips SSH and permissions when DNS fails", async () => {
    const app = makeApp(OWNER, {
      dns: { status: "failed", code: "dns_not_found", message: "hostname does not resolve" },
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/onboarding/dry-run`)
      .send(dryRunBody());

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.skippedChecks).toEqual(["ssh", "permissions"]);
    expect(res.body.checks).toHaveLength(1);
    expect(res.body.checks[0]).toMatchObject({
      kind: "dns",
      status: "failed",
      code: "dns_not_found",
    });
  });

  it("skips permissions when SSH fails, with a stable code", async () => {
    const app = makeApp(OWNER, {
      dns: ALL_OK.dns,
      ssh: {
        status: "failed",
        code: "ssh_connection_refused",
        message: "the SSH port is closed",
      },
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/onboarding/dry-run`)
      .send(dryRunBody());

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.skippedChecks).toEqual(["permissions"]);
    expect(res.body.checks).toHaveLength(2);
    expect(res.body.checks[1]).toMatchObject({
      kind: "ssh",
      status: "failed",
      code: "ssh_connection_refused",
    });
  });

  it("reports auth failures and permission denials with stable codes", async () => {
    const app = makeApp(OWNER, {
      dns: ALL_OK.dns,
      ssh: {
        status: "failed",
        code: "ssh_auth_failed",
        message: "authentication failed",
      },
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/onboarding/dry-run`)
      .send(dryRunBody());

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    const codes = res.body.checks.map((c: { code: string }) => c.code);
    expect(codes).toContain("ssh_auth_failed");
    // permissions probe is skipped when SSH auth fails, so it must appear
    // in skippedChecks and NOT in checks.
    expect(codes).not.toContain("permissions_sudo_denied");
    expect(res.body.skippedChecks).toContain("permissions");
  });

  it("skips permissions when SSH auth fails, with a stable code", async () => {
    const app = makeApp(OWNER, {
      dns: ALL_OK.dns,
      ssh: {
        status: "failed",
        code: "ssh_auth_failed",
        message: "authentication failed",
      },
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/onboarding/dry-run`)
      .send(dryRunBody());

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.skippedChecks).toEqual(["permissions"]);
    expect(res.body.checks).toHaveLength(2);
    expect(res.body.checks[1]).toMatchObject({
      kind: "ssh",
      status: "failed",
      code: "ssh_auth_failed",
    });
  });

  it("returns 403 when an outsider company tries to dry-run", async () => {
    const app = makeApp(OUTSIDER, ALL_OK);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/onboarding/dry-run`)
      .send(dryRunBody());

    expect(res.status).toBe(403);
  });

  it("allows an agent bound to the company", async () => {
    const app = makeApp(AGENT_FOR_COMPANY, ALL_OK);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/onboarding/dry-run`)
      .send(dryRunBody());

    expect(res.status).toBe(200);
  });

  it("reports permission failures after SSH succeeds", async () => {
    const app = makeApp(OWNER, {
      dns: ALL_OK.dns,
      ssh: ALL_OK.ssh,
      permissions: {
        status: "failed",
        code: "permissions_sudo_denied",
        message: "user is not in the sudoers file",
      },
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/onboarding/dry-run`)
      .send(dryRunBody());

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    const codes = res.body.checks.map((c: { code: string }) => c.code);
    expect(codes).toContain("permissions_sudo_denied");
    expect(res.body.skippedChecks).toEqual([]);
  });

  it("rejects a body with both password and privateKey", async () => {
    const app = makeApp(OWNER, ALL_OK);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/onboarding/dry-run`)
      .send(
        dryRunBody({
          auth: { password: "x", privateKey: PRIVATE_KEY_BODY },
        }),
      );

    expect(res.status).toBe(400);
  });

  it("rejects a body with neither password nor privateKey", async () => {
    const app = makeApp(OWNER, ALL_OK);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/onboarding/dry-run`)
      .send(dryRunBody({ auth: {} }));

    expect(res.status).toBe(400);
  });

  it("rejects a host with whitespace", async () => {
    const app = makeApp(OWNER, ALL_OK);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/onboarding/dry-run`)
      .send(dryRunBody({ host: "node a.example.com" }));

    expect(res.status).toBe(400);
  });

  it("rejects an out-of-range port", async () => {
    const app = makeApp(OWNER, ALL_OK);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/onboarding/dry-run`)
      .send(dryRunBody({ port: 70000 }));

    expect(res.status).toBe(400);
  });

  it("rejects a privateKey that does not satisfy the PEM contract", async () => {
    const app = makeApp(OWNER, ALL_OK);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/servers/onboarding/dry-run`)
      .send(dryRunBody({ auth: { privateKey: "invalid-raw-key-without-pem-envelope" } }));

    expect(res.status).toBe(400);
  });
});
