/** myrmidon(OPE-8985): the one-time password-set token never reaches the HTTP log. */
import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHttpLogger } from "../middleware/logger.js";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";
import { isSecretSensitiveHttpRequest } from "../middleware/http-log-policy.js";
import { stripSecretBearingUrlParts } from "../middleware/redact-sensitive.js";

const TOKEN = ["pwset", "canary", "token"].join("-").repeat(3);

describe("password-set token in logs", () => {
  it("masks the path segment", () => {
    expect(stripSecretBearingUrlParts(`/password-set/${TOKEN}`)).toBe("/password-set/[redacted]");
    expect(stripSecretBearingUrlParts(`/api/myrmidon/users-admin-a/password-set/${TOKEN}?x=1`)).toBe("/api/myrmidon/users-admin-a/password-set/[redacted]");
    expect(stripSecretBearingUrlParts("/api/users")).toBe("/api/users");
  });

  it("marks the API route secret-sensitive", () => {
    expect(isSecretSensitiveHttpRequest("POST", "/api/myrmidon/users-admin-a/password-set")).toBe(true);
  });

  it.each([
    ["page ok", "GET", `/password-set/${TOKEN}`, 200],
    ["page error", "GET", `/password-set/${TOKEN}`, 500],
    ["api rejected", "POST", "/api/myrmidon/users-admin-a/password-set", 404],
  ])("%s: no log line contains the token", async (_name, method, path, status) => {
    const chunks: string[] = [];
    const stream = new Writable({ write(chunk, _e, cb) { chunks.push(chunk.toString()); cb(); } });
    const app = express();
    app.use(createHttpLogger(pino({ level: "debug", redact: [...HTTP_LOG_REDACT_PATHS] }, stream)));
    app.use(express.json());
    app.all("/password-set/:token", (_req, res) => {
      res.status(status).end();
    });
    app.all("/api/myrmidon/users-admin-a/password-set", (req, res) => {
      (res as any).__errorContext = { error: { message: `bad ${req.body.token}`, name: "Error" }, reqBody: req.body, reqParams: req.params, reqQuery: {} };
      res.status(status).end();
    });
    const agentCall = request(app)[method.toLowerCase() as "get" | "post"](path);
    await (method === "POST" ? agentCall.send({ token: TOKEN, newPassword: "a-new-password-1" }) : agentCall);
    await new Promise((r) => setTimeout(r, 50));
    const log = chunks.join("");
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain("a-new-password-1");
  });
});
