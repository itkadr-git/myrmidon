import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb } from "@myrmidon/db";
import {
  companies,
  documents,
  issueDocuments,
  issues,
} from "@myrmidon/db";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@myrmidon/db/test-embedded-postgres";
import { issueAcceptanceSnapshotService } from "../services/issue-acceptance-snapshot.js";

const companyA = "11111111-1111-4111-8111-111111111111";
const companyB = "22222222-2222-4222-8222-222222222222";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

d("issueAcceptanceSnapshotService read model (embedded postgres)", () => {
  it(
    "reads issue identity and document revision as one minimal snapshot",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-snapshot-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      const client = db.$client;
      cleanups.push(async () => {
        await (client as any).end();
      });

      const docId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(companies).values({ id: companyA, name: "Company A" });
      const [issue] = await db
        .insert(issues)
        .values({ id: randomUUID(), companyId: companyA, title: "Task", identifier: "OPE-7001" })
        .returning();
      await db.insert(documents).values({
        id: docId,
        companyId: companyA,
        latestBody: "acceptance body",
        latestRevisionId: revisionId,
        latestRevisionNumber: 3,
      });
      await db.insert(issueDocuments).values({
        companyId: companyA,
        issueId: issue!.id,
        documentId: docId,
        key: "acceptance-scenarios",
      });
      // Second issue in the same company without any document.
      const [bare] = await db
        .insert(issues)
        .values({ id: randomUUID(), companyId: companyA, title: "Bare", identifier: "OPE-7002" })
        .returning();

      const withDocument = await issueAcceptanceSnapshotService(db).read(issue!.id);
      expect(withDocument).toEqual({
        issue: { id: issue!.id, identifier: "OPE-7001", companyId: companyA },
        // Revision evidence: the latest revision id is part of the snapshot.
        document: { id: docId, latestRevisionId: revisionId, body: "acceptance body" },
      });

      const withoutDocument = await issueAcceptanceSnapshotService(db).read(bare!.id);
      expect(withoutDocument).toEqual({
        issue: { id: bare!.id, identifier: "OPE-7002", companyId: companyA },
        document: null,
      });

      const missing = await issueAcceptanceSnapshotService(db).read(randomUUID());
      expect(missing).toBeNull();
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "never joins a document bound to another company",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-snapshot-x-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      const client = db.$client;
      cleanups.push(async () => {
        await (client as any).end();
      });

      const foreignDocId = randomUUID();
      await db.insert(companies).values([
        { id: companyA, name: "Company A", issuePrefix: "AAA" },
        { id: companyB, name: "Company B", issuePrefix: "BBB" },
      ]);
      const [issue] = await db
        .insert(issues)
        .values({ id: randomUUID(), companyId: companyA, title: "Task", identifier: "OPE-8001" })
        .returning();
      // Corrupt cross-company binding: a document of company B linked to
      // company A's issue. The read model must refuse to join it.
      await db.insert(documents).values({
        id: foreignDocId,
        companyId: companyB,
        latestBody: "foreign criteria",
        latestRevisionId: randomUUID(),
      });
      await db.insert(issueDocuments).values({
        companyId: companyB,
        issueId: issue!.id,
        documentId: foreignDocId,
        key: "acceptance-scenarios",
      });

      const snapshot = await issueAcceptanceSnapshotService(db).read(issue!.id);
      expect(snapshot).toEqual({
        issue: { id: issue!.id, identifier: "OPE-8001", companyId: companyA },
        document: null,
      });
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});
