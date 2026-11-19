import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  companies,
  companySecrets,
  companySecretVersions,
  companySecretBindings,
  toolApplications,
  toolConnections,
  createDb,
} from "@myrmidon/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";
import { secretService } from "../services/secrets.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("connector credential references", () => {
  it("creates, reads, updates and removes only vault references, rejecting missing or foreign secrets", async () => {
    const pg = await startEmbeddedPostgresTestDatabase("myrmidon-connector-credentials-");
    const db = createDb(pg.connectionString);
    try {
      const [company, otherCompany] = await db.insert(companies).values([
        { name: "Connector credentials", issuePrefix: `CC${randomUUID().slice(0, 6)}` },
        { name: "Foreign connector credentials", issuePrefix: `FC${randomUUID().slice(0, 6)}` },
      ]).returning();
      const secret = await secretService(db).create(company!.id, {
        name: "Connector API key", key: `tool_app.${randomUUID()}.credentials_apiKey`,
        provider: "local_encrypted", value: "connector-secret-value",
      });
      const foreignSecret = await secretService(db).create(otherCompany!.id, {
        name: "Foreign API key", key: `tool_app.${randomUUID()}.credentials_apiKey`,
        provider: "local_encrypted", value: "foreign-secret-value",
      });
      const service = toolAccessService(db);
      const connection = await service.createConnection(company!.id, {
        applicationName: "Private connector", name: "Private connector",
        transport: "mcp_remote", authKind: "api_key",
        config: { url: "https://93.184.216.34/mcp" },
        credentialSecretRefs: [{ secretId: secret.id, configPath: "credentials.apiKey", label: "API key" }],
      });
      const raw = await db.select().from(toolConnections).where(eq(toolConnections.id, connection.id));
      expect(raw[0]!.credentialSecretRefs).toEqual(connection.credentialSecretRefs);
      expect(JSON.stringify(raw[0])).not.toContain("connector-secret-value");
      expect(JSON.stringify(await service.getConnection(connection.id))).not.toContain("connector-secret-value");
      await expect(service.createConnection(company!.id, {
        applicationName: "Missing connector", name: "Missing connector", transport: "mcp_remote",
        credentialSecretRefs: [{ secretId: randomUUID(), configPath: "credentials.apiKey" }],
      })).rejects.toMatchObject({ status: 422 });
      await expect(service.createConnection(company!.id, {
        applicationName: "Foreign connector", name: "Foreign connector", transport: "mcp_remote",
        credentialSecretRefs: [{ secretId: foreignSecret.id, configPath: "credentials.apiKey" }],
      })).rejects.toMatchObject({ status: 422 });
      const replacement = await secretService(db).create(company!.id, {
        name: "Replacement API key", key: `tool_app.${randomUUID()}.credentials_apiKey`,
        provider: "local_encrypted", value: "replacement-secret-value",
      });
      const updated = await service.updateConnection(connection.id, {
        credentialSecretRefs: [{ secretId: replacement.id, configPath: "credentials.apiKey" }],
      });
      expect(updated.credentialSecretRefs[0]?.secretId).toBe(replacement.id);
      const storedVersion = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secret.id));
      expect(JSON.stringify(storedVersion)).not.toContain("connector-secret-value");
      expect(JSON.stringify(updated)).not.toContain("replacement-secret-value");
      const removed = await service.archiveConnection(connection.id, company!.id);
      expect(removed.connection.credentialSecretRefs).toEqual([]);
      expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, connection.id))).toEqual([]);
      expect(JSON.stringify(removed)).not.toContain("replacement-secret-value");
      await db.delete(companySecrets);
      await db.delete(toolConnections);
      await db.delete(toolApplications);
      await db.delete(companies);
    } finally {
      await pg.cleanup();
    }
  });
});
