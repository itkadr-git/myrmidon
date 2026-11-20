import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { acceptanceServiceCredentials, companies, createDb } from "@myrmidon/db";
import { eq } from "drizzle-orm";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@myrmidon/db/test-embedded-postgres";
import { acceptanceServiceCredentialsService } from "../services/acceptance-service-credentials.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("acceptance service credentials", () => {
  it("binds credentials to company, certificate, expiry and revocation", async () => {
    const fixture = await startEmbeddedPostgresTestDatabase("acceptance-service-credential-");
    const db = createDb(fixture.connectionString);
    try {
      const companyId = randomUUID();
      const otherCompany = randomUUID();
      await db.insert(companies).values([{ id: companyId, name: "A", issuePrefix: "AAA" }, { id: otherCompany, name: "B", issuePrefix: "BBB" }]);
      const service = acceptanceServiceCredentialsService(db);
      const fingerprint = "a".repeat(64);
      const issued = await service.issue(companyId, fingerprint, new Date(Date.now() + 60_000));
      expect(await service.authenticate(issued.token, fingerprint)).toEqual({ companyId });
      expect(await service.authenticate(issued.token, "b".repeat(64))).toBeNull();
      expect(await service.authenticate("board-key", fingerprint)).toBeNull();
      expect(await service.revoke(otherCompany, issued.id)).toBe(false);
      expect(await service.authenticate(issued.token, fingerprint)).toEqual({ companyId });
      expect(await service.revoke(companyId, issued.id)).toBe(true);
      expect(await service.authenticate(issued.token, fingerprint)).toBeNull();
      const expiring = await service.issue(companyId, fingerprint, new Date(Date.now() + 60_000));
      await db.update(acceptanceServiceCredentials).set({ expiresAt: new Date(0) }).where(eq(acceptanceServiceCredentials.id, expiring.id));
      expect(await service.authenticate(expiring.token, fingerprint)).toBeNull();
    } finally {
      await db.$client.end();
      await fixture.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
