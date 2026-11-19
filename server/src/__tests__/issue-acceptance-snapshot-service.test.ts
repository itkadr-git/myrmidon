import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb } from "@myrmidon/db";
import {
  companies,
  documentRevisions,
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
      // The snapshot serves the published revision's body; the revision row
      // must exist, bind to this document and match latest_body.
      await db.insert(documentRevisions).values({
        id: revisionId,
        companyId: companyA,
        documentId: docId,
        revisionNumber: 3,
        body: "acceptance body",
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
        // Revision evidence: the latest revision id and the monotonic
        // generation number are part of the snapshot.
        document: { id: docId, latestRevisionId: revisionId, latestRevisionNumber: 3, body: "acceptance body" },
      });

      // The same snapshot is reachable by canonical identifier in the same
      // single-statement read.
      const byIdentifier = await issueAcceptanceSnapshotService(db).read("OPE-7001");
      expect(byIdentifier).toEqual(withDocument);

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

  it(
    "never returns a foreign document reachable through an own-company link (OPE-15145)",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-snapshot-link-a-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      const client = db.$client;
      cleanups.push(async () => {
        await (client as any).end();
      });

      await db.insert(companies).values([
        { id: companyA, name: "Company A", issuePrefix: "AAA" },
        { id: companyB, name: "Company B", issuePrefix: "BBB" },
      ]);
      const [issue] = await db
        .insert(issues)
        .values({ id: randomUUID(), companyId: companyA, title: "Task", identifier: "OPE-8101" })
        .returning();
      // The reviewer's repro shape: the LINK row is a legitimate company A
      // row, but it points at a document owned by company B. A join on
      // documents.id alone would serve B's secret body under A's issue.
      const foreignDocId = randomUUID();
      const foreignRevisionId = randomUUID();
      await db.insert(documents).values({
        id: foreignDocId,
        companyId: companyB,
        latestBody: "foreign secret",
        latestRevisionId: foreignRevisionId,
      });
      await db.insert(documentRevisions).values({
        id: foreignRevisionId,
        companyId: companyB,
        documentId: foreignDocId,
        revisionNumber: 1,
        body: "foreign secret",
      });
      await db.insert(issueDocuments).values({
        companyId: companyA,
        issueId: issue!.id,
        documentId: foreignDocId,
        key: "acceptance-scenarios",
      });

      const snapshot = await issueAcceptanceSnapshotService(db).read(issue!.id);
      expect(snapshot).toEqual({
        issue: { id: issue!.id, identifier: "OPE-8101", companyId: companyA },
        document: null,
      });
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "binds the published revision by document, company and exact body, and fails closed otherwise (OPE-15145)",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-snapshot-rev-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      const client = db.$client;
      cleanups.push(async () => {
        await (client as any).end();
      });

      await db.insert(companies).values([
        { id: companyA, name: "Company A", issuePrefix: "AAA" },
        { id: companyB, name: "Company B", issuePrefix: "BBB" },
      ]);

      const seedGraph = async (identifier: string, mutate: (graph: {
        docId: string;
        revisionId: string;
        otherDocId: string;
        otherRevisionId: string;
      }) => Promise<void>) => {
        const [issue] = await db
          .insert(issues)
          .values({ id: randomUUID(), companyId: companyA, title: "Task", identifier })
          .returning();
        const docId = randomUUID();
        const revisionId = randomUUID();
        const otherDocId = randomUUID();
        const otherRevisionId = randomUUID();
        await db.insert(documents).values([
          {
            id: docId,
            companyId: companyA,
            latestBody: `body for ${identifier}`,
            latestRevisionId: revisionId,
          },
          // A second, unrelated company A document+revision used to test
          // that latest_revision_id must point at THIS document's revision.
          {
            id: otherDocId,
            companyId: companyA,
            latestBody: "other body",
            latestRevisionId: otherRevisionId,
          },
        ]);
        await db.insert(documentRevisions).values([
          {
            id: revisionId,
            companyId: companyA,
            documentId: docId,
            revisionNumber: 1,
            body: `body for ${identifier}`,
          },
          {
            id: otherRevisionId,
            companyId: companyA,
            documentId: otherDocId,
            revisionNumber: 1,
            body: "other body",
          },
        ]);
        await db.insert(issueDocuments).values({
          companyId: companyA,
          issueId: issue!.id,
          documentId: docId,
          key: "acceptance-scenarios",
        });
        await mutate({ docId, revisionId, otherDocId, otherRevisionId });
        return issue!;
      };

      // Correct graph: every company_id is A, revision binds by id,
      // document_id and exact body — the snapshot serves the revision body.
      const healthy = await seedGraph("OPE-8201", async () => {});
      expect(await issueAcceptanceSnapshotService(db).read(healthy.id)).toEqual({
        issue: { id: healthy.id, identifier: "OPE-8201", companyId: companyA },
        document: expect.objectContaining({ body: "body for OPE-8201" }),
      });

      // latest_revision_id points at the revision of ANOTHER document (same
      // company): the revision join must fail, not serve the other body.
      const wrongRevisionTarget = await seedGraph("OPE-8202", async ({ docId, otherRevisionId }) => {
        await db.update(documents)
          .set({ latestRevisionId: otherRevisionId })
          .where(eq(documents.id, docId));
      });
      expect((await issueAcceptanceSnapshotService(db).read(wrongRevisionTarget.id))!.document).toBeNull();

      // The revision row itself belongs to company B.
      const foreignRevision = await seedGraph("OPE-8203", async ({ revisionId }) => {
        await db.update(documentRevisions)
          .set({ companyId: companyB })
          .where(eq(documentRevisions.id, revisionId));
      });
      expect((await issueAcceptanceSnapshotService(db).read(foreignRevision.id))!.document).toBeNull();

      // documents.latest_body diverged from the published revision body.
      const divergedBody = await seedGraph("OPE-8204", async ({ docId }) => {
        await db.update(documents)
          .set({ latestBody: "rewritten outside the revision log" })
          .where(eq(documents.id, docId));
      });
      expect((await issueAcceptanceSnapshotService(db).read(divergedBody.id))!.document).toBeNull();
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});
