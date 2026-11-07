import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHttpLogger } from "../middleware/logger.js";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";
import { isSecretSensitiveHttpRequest } from "../middleware/http-log-policy.js";
import {
  maskInviteToken,
  stripSecretBearingUrlParts,
} from "../middleware/redact-sensitive.js";

const TOKEN = "pcp_invite_secret_token_1234567890";

describe("invite token in API logs (OPE-11891)", () => {
  it("masks invite tokens in URL paths", () => {
    expect(stripSecretBearingUrlParts(`/invites/${TOKEN}`)).toBe(
      "/invites/[redacted]",
    );
    expect(stripSecretBearingUrlParts(`/api/invites/${TOKEN}/accept`)).toBe(
      "/api/invites/[redacted]/accept",
    );
    expect(stripSecretBearingUrlParts(`/invite/${TOKEN}`)).toBe(
      "/invite/[redacted]",
    );
    expect(maskInviteToken(`/api/invites/${TOKEN}?foo=bar`)).toBe(
      "/api/invites/[redacted]?foo=bar",
    );
  });

  it("marks invite-sensitive endpoints as secret-sensitive", () => {
    expect(
      isSecretSensitiveHttpRequest(
        "POST",
        "/api/companies/comp-123/invites",
      ),
    ).toBe(true);
    expect(
      isSecretSensitiveHttpRequest(
        "POST",
        `/api/invites/${TOKEN}/accept`,
      ),
    ).toBe(true);
  });

  it.each([
    ["get invite ok", "GET", `/api/invites/${TOKEN}`, 200],
    ["get invite 404", "GET", `/api/invites/${TOKEN}`, 404],
    ["accept invite 400", "POST", `/api/invites/${TOKEN}/accept`, 400],
    ["accept invite 500", "POST", `/api/invites/${TOKEN}/accept`, 500],
  ])("%s: no log line contains the token", async (_name, method, path, status) => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _e, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    const app = express();
    app.use(
      createHttpLogger(
        pino({ level: "debug", redact: [...HTTP_LOG_REDACT_PATHS] }, stream),
      ),
    );
    app.use(express.json());
    app.all("/api/invites/:token", (req, res) => {
      (res as any).__errorContext = {
        error: { message: `bad ${req.params.token}`, name: "Error" },
        reqBody: req.body,
        reqParams: req.params,
        reqQuery: {},
      };
      res.status(status).end();
    });
    app.all("/api/invites/:token/accept", (req, res) => {
      (res as any).__errorContext = {
        error: { message: `failed to accept ${req.params.token}`, name: "Error" },
        reqBody: req.body,
        reqParams: req.params,
        reqQuery: {},
      };
      res.status(status).end();
    });

    const agentCall = request(app)[method.toLowerCase() as "get" | "post"](path);
    await (method === "POST"
      ? agentCall
          .set("x-invite-token", TOKEN)
          .send({ inviteToken: TOKEN, secret: "password123" })
      : agentCall.set("x-invite-token", TOKEN));

    await new Promise((r) => setTimeout(r, 50));
    const log = chunks.join("");
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain("password123");
  });
});
