import { execFileSync } from "node:child_process";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpsRequest } from "node:https";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import express from "express";
import { describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@myrmidon/db";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@myrmidon/db/test-embedded-postgres";
import { acceptanceServiceCredentialsService } from "../services/acceptance-service-credentials.js";
import { acceptanceServiceRoutes } from "../routes/acceptance-service.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("acceptance service TLS route", () => {
  it("binds credentials to a verified certificate and company and enforces strong revision pins", async () => {
    const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR ?? process.env.TMPDIR ?? process.cwd(), "acceptance-tls-"));
    const pair = (name: string) => {
      const keyPath = join(dir, `${name}.key`), certPath = join(dir, `${name}.crt`);
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", `/CN=${name}`], { stdio: "ignore" });
      return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
    };
    const serverCert = pair("server"), client = pair("client"), other = pair("other");
    const fixture = await startEmbeddedPostgresTestDatabase("acceptance-tls-route-");
    const db = createDb(fixture.connectionString);
    const app = express();
    app.use("/api", acceptanceServiceRoutes(db));
    app.use(errorHandler);
    const server = createServer({ ...serverCert, ca: [client.cert, other.cert], requestCert: true, rejectUnauthorized: true }, app);
    try {
      const companyId = randomUUID(), foreignId = randomUUID(), issueId = randomUUID();
      await db.insert(companies).values([{ id: companyId, name: "A", issuePrefix: "AAA" }, { id: foreignId, name: "B", issuePrefix: "BBB" }]);
      await db.insert(issues).values({ id: issueId, companyId, title: "Task", identifier: "AAA-1" });
      const fingerprint = createHash("sha256").update(new X509Certificate(client.cert).raw).digest("hex");
      const service = acceptanceServiceCredentialsService(db);
      const issued = await service.issue(companyId, fingerprint, new Date(Date.now() + 60_000));
      const submit = await service.issueFinalization(companyId, fingerprint, new Date(Date.now() + 60_000));
      const foreign = await service.issue(foreignId, fingerprint, new Date(Date.now() + 60_000));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("listener unavailable");
      const call = (token: string, cert = client, match?: string, ref = "AAA-1") => new Promise<{ status: number; etag?: string; body: string }>((resolve, reject) => {
        const req = httpsRequest({ host: "127.0.0.1", port: address.port, path: `/api/service/issues/${ref}/acceptance-scenarios`, method: "GET", ...cert, rejectUnauthorized: false, headers: { authorization: `Bearer ${token}`, ...(match ? { "if-match": match } : {}) } }, (res) => {
          let body = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, etag: res.headers.etag, body }));
        });
        req.on("error", reject); req.end();
      });
      const submitWithoutPin = await new Promise<number>((resolve, reject) => {
        const req = httpsRequest({
          host: "127.0.0.1", port: address.port,
          path: `/api/service/native-runs/${randomUUID()}/finalization-requests`,
          method: "POST", ...client, rejectUnauthorized: false,
          headers: { authorization: `Bearer ${submit.token}`, "idempotency-key": "test-request" },
        }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
        req.on("error", reject); req.end();
      });
      expect(submitWithoutPin).toBe(428);
      const first = await call(issued.token);
      expect(first.status).toBe(200);
      expect(first.etag).toMatch(/^"[a-f0-9]{64}"$/);
      expect(JSON.parse(first.body).issue.id).toBe(issueId);
      expect((await call(issued.token, client, first.etag)).status).toBe(200);
      expect((await call(issued.token, client, `W/${first.etag}`)).status).toBe(412);
      expect((await call(issued.token, other)).status).toBe(401);
      expect((await call(submit.token)).status).toBe(401);
      expect((await call(foreign.token)).status).toBe(404);
      const concurrent = await Promise.all(Array.from({ length: 8 }, () => call(issued.token, client, first.etag)));
      expect(concurrent.every((response) => response.status === 200 && response.etag === first.etag)).toBe(true);
      const [racingReads] = await Promise.all([
        Promise.all(Array.from({ length: 8 }, () => call(issued.token, client, first.etag, issueId))),
        db.update(issues).set({ identifier: "AAA-2" }).where(eq(issues.id, issueId)),
      ]);
      for (const response of racingReads) {
        expect([200, 412]).toContain(response.status);
        if (response.status === 200) {
          expect(response.etag).toBe(first.etag);
          expect(JSON.parse(response.body).issue.identifier).toBe("AAA-1");
        }
      }
      expect((await call(issued.token, client, first.etag, issueId)).status).toBe(412);
      const [revocationReads] = await Promise.all([
        Promise.all(Array.from({ length: 8 }, () => call(issued.token, client, undefined, issueId))),
        service.revoke(companyId, issued.id),
      ]);
      expect(revocationReads.every((response) => response.status === 200 || response.status === 401)).toBe(true);
      expect((await call(issued.token, client, undefined, issueId)).status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.$client.end(); await fixture.cleanup(); rmSync(dir, { recursive: true, force: true });
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
