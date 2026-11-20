import { execFileSync } from "node:child_process";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:https";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import express from "express";
import { expect, it } from "vitest";
import { acceptanceServiceCredentials, companies, createDb, issues } from "@myrmidon/db";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, startEmbeddedPostgresTestDatabase } from "@myrmidon/db/test-embedded-postgres";
import { acceptanceServiceCredentialsService } from "../services/acceptance-service-credentials.js";
import { acceptanceServiceRoutes } from "../routes/acceptance-service.js";
import { errorHandler } from "../middleware/index.js";
import { start } from "../../../scripts/myrmidon/privileged-ci/acceptance-reader/main.mjs";
import { createPersistentCredentialStore } from "../../../scripts/myrmidon/privileged-ci/acceptance-reader/persistent-credentials.mjs";

it("gateway HTTPS reaches real core with company, lifecycle and revision enforcement", async () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR ?? process.env.TMPDIR ?? process.cwd(), "reader-core-"));
  const file = (name: string) => join(dir, name);
  const pair = (name: string) => {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", file(`${name}.key`), "-out", file(`${name}.crt`), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
    return { key: readFileSync(file(`${name}.key`)), cert: readFileSync(file(`${name}.crt`)) };
  };
  const coreTls = pair("core"), client = pair("client"), gatewayTls = pair("gateway");
  const fixture = await startEmbeddedPostgresTestDatabase("reader-real-core-");
  const db = createDb(fixture.connectionString);
  const app = express();
  app.use("/api", acceptanceServiceRoutes(db)); app.use(errorHandler);
  const core = createServer({ ...coreTls, ca: client.cert, requestCert: true, rejectUnauthorized: true }, app);
  let gateway: ReturnType<typeof start> | undefined;
  try {
    const companyId = randomUUID(), foreignCompany = randomUUID(), issueId = randomUUID(), foreignIssue = randomUUID();
    await db.insert(companies).values([{ id: companyId, name: "A", issuePrefix: "AAA" }, { id: foreignCompany, name: "B", issuePrefix: "BBB" }]);
    await db.insert(issues).values([{ id: issueId, companyId, title: "Task", identifier: "AAA-1" }, { id: foreignIssue, companyId: foreignCompany, title: "Foreign", identifier: "BBB-1" }]);
    const service = acceptanceServiceCredentialsService(db);
    const fingerprint = createHash("sha256").update(new X509Certificate(client.cert).raw).digest("hex");
    const issued = await service.issue(companyId, fingerprint, new Date(Date.now() + 60_000));
    writeFileSync(file("service-token"), issued.token, { mode: 0o600 });
    const candidate = "synthetic-candidate-token";
    const hash = createHash("sha256").update(candidate).digest("hex");
    mkdirSync(file("credentials"));
    const store = createPersistentCredentialStore(file("credentials"));
    store.issue({ tokenHash: hash, companyId, expiresAt: Date.now() + 60_000 });
    await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
    const address = core.address(); if (!address || typeof address === "string") throw new Error("core listener unavailable");
    const reservation = createNetServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const reserved = reservation.address(); if (!reserved || typeof reserved === "string") throw new Error("port unavailable");
    const port = reserved.port; await new Promise<void>((resolve) => reservation.close(() => resolve()));
    gateway = start({ host: "127.0.0.1", port, credentialDirectory: file("credentials"), auditFile: file("audit"), listener: { cert: file("gateway.crt"), key: file("gateway.key") }, upstream: { origin: `https://localhost:${address.port}`, ca: file("core.crt"), cert: file("client.crt"), key: file("client.key"), tokenFile: file("service-token") } });
    await new Promise<void>((resolve) => gateway!.once("listening", resolve));
    const call = (ref: string, etag?: string) => new Promise<{ status: number; body: string; etag?: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", servername: "localhost", port, ca: gatewayTls.cert, path: `/api/issues/${ref}/acceptance-snapshot`, method: "GET", headers: { authorization: `Bearer ${candidate}`, ...(etag ? { "if-match": etag } : {}) } }, (res) => {
        let body = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body, etag: res.headers.etag }));
      });
      req.on("error", reject); req.end();
    });
    const first = await call("AAA-1"); expect(first.status).toBe(200);
    const pin = JSON.parse(first.body); expect(pin).toEqual({ issue: { identifier: "AAA-1", companyId }, document: null });
    expect((await call(issueId)).status).toBe(200);
    expect((await call("BBB-1")).status).toBe(404); expect((await call(foreignIssue)).status).toBe(404);
    expect((await call(issueId, first.etag)).status).toBe(200);
    await db.update(issues).set({ title: "Changed" }).where(eq(issues.id, issueId));
    expect((await call(issueId, first.etag)).status).toBe(412);
    await db.update(acceptanceServiceCredentials).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(acceptanceServiceCredentials.id, issued.id));
    expect((await call(issueId)).status).toBe(502);
    await db.update(acceptanceServiceCredentials).set({ expiresAt: new Date(Date.now() + 60_000) }).where(eq(acceptanceServiceCredentials.id, issued.id));
    expect((await call(issueId)).status).toBe(200);
    await service.revoke(companyId, issued.id);
    expect((await call(issueId)).status).toBe(502);
    store.revoke(hash); expect((await call(issueId)).status).toBe(401);
    const audit = readFileSync(file("audit"), "utf8");
    expect(audit).not.toContain(candidate); expect(audit).not.toContain(issued.token);
  } finally {
    if (gateway) await new Promise<void>((resolve) => gateway!.close(() => resolve()));
    await new Promise<void>((resolve) => core.close(() => resolve()));
    await db.$client.end(); await fixture.cleanup(); rmSync(dir, { recursive: true, force: true });
  }
}, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
