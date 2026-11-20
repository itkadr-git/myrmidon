import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { activityLog, companies, createDb } from "@myrmidon/db";
import { eq } from "drizzle-orm";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@myrmidon/db/test-embedded-postgres";
import { acceptanceServiceCredentialsService } from "../services/acceptance-service-credentials.js";
import { acceptanceServiceCredentialRoutes } from "../routes/acceptance-service-credentials.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("acceptance service credential routes", () => {
  it("authorizes company operators, audits issuance and revocation, and never accepts agent issuance", async () => {
    const fixture = await startEmbeddedPostgresTestDatabase("acceptance-credential-route-");
    const db = createDb(fixture.connectionString);
    try {
      const companyId = randomUUID();
      const otherCompany = randomUUID();
      await db.insert(companies).values([{ id: companyId, name: "A", issuePrefix: "AAA" }, { id: otherCompany, name: "B", issuePrefix: "BBB" }]);
      const actor = { type: "board", userId: "operator", source: "session", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "operator" }] };
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { Object.assign(req, { actor: req.header("x-test-agent") ? { type: "agent", companyId } : actor }); next(); });
      app.use("/api", acceptanceServiceCredentialRoutes(db));
      app.use(errorHandler);
      const path = `/api/companies/${companyId}/acceptance-service-credentials`;
      const input = { certificateSha256: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() };
      expect((await request(app).post(path).set("x-test-agent", "1").send(input)).status).toBe(403);
      expect((await request(app).post(`/api/companies/${otherCompany}/acceptance-service-credentials`).send(input)).status).toBe(403);
      const issued = await request(app).post(path).send(input);
      expect(issued.status, issued.text).toBe(201);
      expect(issued.headers["cache-control"]).toBe("no-store");
      expect(await acceptanceServiceCredentialsService(db).authenticate(issued.body.token, input.certificateSha256)).toEqual({ companyId });
      expect((await request(app).delete(`${path}/${issued.body.id}`)).status).toBe(204);
      expect(await acceptanceServiceCredentialsService(db).authenticate(issued.body.token, input.certificateSha256)).toBeNull();
      const submitPath = `/api/companies/${companyId}/native-finalization-service-credentials`;
      expect((await request(app).post(submitPath).set("x-test-agent", "1").send(input)).status).toBe(403);
      const submit = await request(app).post(submitPath).send(input);
      expect(submit.status, submit.text).toBe(201);
      const service = acceptanceServiceCredentialsService(db);
      expect(await service.authenticate(submit.body.token, input.certificateSha256)).toBeNull();
      expect(await service.authenticateFinalization(submit.body.token, input.certificateSha256)).toEqual({ companyId, credentialId: submit.body.id });
      expect((await request(app).delete(`${path}/${submit.body.id}`)).status).toBe(404);
      expect((await request(app).delete(`${submitPath}/${submit.body.id}`)).status).toBe(204);
      expect(await service.authenticateFinalization(submit.body.token, input.certificateSha256)).toBeNull();
      const entries = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
      expect(entries.map((entry) => entry.action).sort()).toEqual(["acceptance_service_credential.issued", "acceptance_service_credential.revoked", "native_finalization_service_credential.issued", "native_finalization_service_credential.revoked"]);
      expect(JSON.stringify(entries)).not.toContain(issued.body.token);
    } finally {
      await db.$client.end();
      await fixture.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
