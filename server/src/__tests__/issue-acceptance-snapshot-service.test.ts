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
        issue: { id: issue!.id, identifier: "OPE-7001", companyId: companyA, version: "1" },
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
        issue: { id: bare!.id, identifier: "OPE-7002", companyId: companyA, version: "0" },
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
        issue: { id: issue!.id, identifier: "OPE-8001", companyId: companyA, version: "1" },
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
        issue: { id: issue!.id, identifier: "OPE-8101", companyId: companyA, version: "1" },
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
        issue: { id: healthy.id, identifier: "OPE-8201", companyId: companyA, version: "1" },
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

  it(
    "bumps the issue version on every relevant mutation, including identity A->B->A (OPE-15145)",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-snapshot-ver-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      const client = db.$client;
      cleanups.push(async () => {
        await (client as any).end();
      });

      await db.insert(companies).values({ id: companyA, name: "Company A" });
      const [issue] = await db
        .insert(issues)
        .values({ id: randomUUID(), companyId: companyA, title: "Task", identifier: "OPE-8301" })
        .returning();
      const versionOf = async () => (await issueAcceptanceSnapshotService(db).read(issue!.id))!.issue.version;
      expect(await versionOf()).toBe("0");

      // Link insert bumps.
      const docId = randomUUID();
      await db.insert(documents).values({
        id: docId,
        companyId: companyA,
        latestBody: "v1",
        latestRevisionId: randomUUID(),
      });
      await db.insert(issueDocuments).values({
        companyId: companyA,
        issueId: issue!.id,
        documentId: docId,
        key: "acceptance-scenarios",
      });
      expect(await versionOf()).toBe("1");

      // Identity A->B->A still moves the version twice.
      await db.update(issues).set({ identifier: "OPE-8301-TMP" }).where(eq(issues.id, issue!.id));
      expect(await versionOf()).toBe("2");
      await db.update(issues).set({ identifier: "OPE-8301" }).where(eq(issues.id, issue!.id));
      expect(await versionOf()).toBe("3");

      // Company A->B->A (the tenant move) moves it twice as well.
      await db.insert(companies).values({ id: companyB, name: "Company B", issuePrefix: "BBB" });
      await db.update(issues).set({ companyId: companyB }).where(eq(issues.id, issue!.id));
      expect((await issueAcceptanceSnapshotService(db).read(issue!.id))!.issue.companyId).toBe(companyB);
      expect((await issueAcceptanceSnapshotService(db).read(issue!.id))!.issue.version).toBe("4");
      await db.update(issues).set({ companyId: companyA }).where(eq(issues.id, issue!.id));
      expect((await issueAcceptanceSnapshotService(db).read(issue!.id))!.issue.version).toBe("5");

      // A bound-document update bumps through the documents trigger.
      await db.update(documents).set({ latestBody: "v2" }).where(eq(documents.id, docId));
      expect(await versionOf()).toBe("6");

      // Link delete bumps (a delete+recreate is a visible mutation).
      await db.delete(issueDocuments).where(eq(issueDocuments.documentId, docId));
      expect(await versionOf()).toBe("7");
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "versions survive nesting, concurrency, cascades and resist direct resets (OPE-15145)",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-snapshot-conc-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      const sql = db.$client as any;
      cleanups.push(async () => {
        await sql.end();
      });

      await db.insert(companies).values({ id: companyA, name: "Company A" });
      const [issue] = await db
        .insert(issues)
        .values({ id: randomUUID(), companyId: companyA, title: "Task", identifier: "OPE-8401" })
        .returning();
      const issueId = issue!.id;
      const docId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(documents).values({
        id: docId,
        companyId: companyA,
        latestBody: "v1",
        latestRevisionId: revisionId,
      });
      await db.insert(documentRevisions).values({
        id: revisionId,
        companyId: companyA,
        documentId: docId,
        revisionNumber: 1,
        body: "v1",
      });
      await db.insert(issueDocuments).values({
        companyId: companyA,
        issueId,
        documentId: docId,
        key: "acceptance-scenarios",
      });
      const versionOf = async () => (await issueAcceptanceSnapshotService(db).read(issueId))!.issue.version;
      expect(await versionOf()).toBe("1");

      // A nested writer (another trigger changing the link at trigger depth
      // 2) must still move the version; the guard is only against the bump
      // function's own recursion.
      await sql.unsafe(`
        CREATE TABLE acceptance_nest_probe (key text primary key);
        CREATE FUNCTION acceptance_nest_writer() RETURNS trigger AS $t$
        BEGIN
          UPDATE issue_documents SET updated_at = now()
            WHERE issue_id = '${issueId}' AND key = 'acceptance-scenarios';
          RETURN NULL;
        END;
        $t$ LANGUAGE plpgsql;
        CREATE TRIGGER acceptance_nest_trg
          AFTER INSERT ON acceptance_nest_probe
          FOR EACH ROW EXECUTE FUNCTION acceptance_nest_writer();
      `);
      await sql.unsafe(`INSERT INTO acceptance_nest_probe (key) VALUES ('n1')`);
      expect(await versionOf()).toBe("2");

      // Concurrent bumps from two writers on the same issue serialize into
      // two increments.
      const writeDocument = (body: string) => db.transaction(async (tx) => {
        // Mirror the real write path: the revision log and latest_body move
        // together, keeping the snapshot's revision-binding invariant.
        await tx.update(documentRevisions).set({ body }).where(eq(documentRevisions.id, revisionId));
        await tx.update(documents).set({ latestBody: body, latestRevisionId: revisionId }).where(eq(documents.id, docId));
      });
      await Promise.all([
        writeDocument("c1"),
        db.update(issues).set({ title: "c1" }).where(eq(issues.id, issueId)),
      ]);
      expect(await versionOf()).toBe("4");

      // An uncommitted writer is invisible; its commit moves the version.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const pending = db.transaction(async (tx) => {
        await tx.update(documentRevisions).set({ body: "tx1" }).where(eq(documentRevisions.id, revisionId));
        await tx.update(documents).set({ latestBody: "tx1", latestRevisionId: revisionId }).where(eq(documents.id, docId));
        await gate;
      });
      try {
        const during = await issueAcceptanceSnapshotService(db).read(issueId);
        expect(during.document!.body).toBe("c1");
        expect(during.issue.version).toBe("4");
      } finally {
        release();
      }
      await pending;
      const after = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(after.document!.body).toBe("tx1");
      expect(after.issue.version).toBe("5");

      // Deleting the document cascades to its link row; the cascade delete
      // bumps the version and the snapshot loses the document.
      await db.delete(documents).where(eq(documents.id, docId));
      const cascaded = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(cascaded.document).toBeNull();
      expect(cascaded.issue.version).toBe("6");

      // Direct resets are forbidden: the version is trigger-managed and
      // monotonic, any writer trying to wind it back is rejected.
      await expect(
        db.update(issues).set({ acceptanceSnapshotVersion: BigInt("1") }).where(eq(issues.id, issueId)),
      ).rejects.toThrow();

      // Bigint generations are exact beyond 2^53: adjacent values stay
      // distinguishable where JS numbers would collapse. Setting the version
      // is itself an issues-row update, so the trigger adds one on top.
      await db.update(issues).set({ acceptanceSnapshotVersion: BigInt("9007199254740992") }).where(eq(issues.id, issueId));
      const big = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(big.issue.version).toBe("9007199254740993");
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});
