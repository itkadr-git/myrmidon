import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql as sqlTag } from "drizzle-orm";
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
import { documentService } from "../services/documents.js";

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
        issue: { id: issue!.id, identifier: "OPE-7001", companyId: companyA, version: "2" },
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
        issue: { id: bare!.id, identifier: "OPE-7002", companyId: companyA, version: "1" },
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
        issue: { id: issue!.id, identifier: "OPE-8001", companyId: companyA, version: "2" },
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
        issue: { id: issue!.id, identifier: "OPE-8101", companyId: companyA, version: "2" },
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
        issue: { id: healthy.id, identifier: "OPE-8201", companyId: companyA, version: "2" },
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
      expect(await versionOf()).toBe("1");

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
      expect(await versionOf()).toBe("2");

      // Identity A->B->A still moves the version twice.
      await db.update(issues).set({ identifier: "OPE-8301-TMP" }).where(eq(issues.id, issue!.id));
      expect(await versionOf()).toBe("3");
      await db.update(issues).set({ identifier: "OPE-8301" }).where(eq(issues.id, issue!.id));
      expect(await versionOf()).toBe("4");

      // Company A->B->A (the tenant move) moves it twice as well.
      await db.insert(companies).values({ id: companyB, name: "Company B", issuePrefix: "BBB" });
      await db.update(issues).set({ companyId: companyB }).where(eq(issues.id, issue!.id));
      expect((await issueAcceptanceSnapshotService(db).read(issue!.id))!.issue.companyId).toBe(companyB);
      expect((await issueAcceptanceSnapshotService(db).read(issue!.id))!.issue.version).toBe("5");
      await db.update(issues).set({ companyId: companyA }).where(eq(issues.id, issue!.id));
      expect((await issueAcceptanceSnapshotService(db).read(issue!.id))!.issue.version).toBe("6");

      // A bound-document update bumps through the documents trigger.
      await db.update(documents).set({ latestBody: "v2" }).where(eq(documents.id, docId));
      expect(await versionOf()).toBe("7");

      // Link delete bumps (a delete+recreate is a visible mutation).
      await db.delete(issueDocuments).where(eq(issueDocuments.documentId, docId));
      expect(await versionOf()).toBe("8");
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
      expect(await versionOf()).toBe("2");

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
      expect(await versionOf()).toBe("3");

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
      expect(await versionOf()).toBe("6");

      // An uncommitted writer is invisible until commit; the read is
      // barriered on the writer itself, not on timing: the writer signals
      // after BOTH updates have executed while its transaction is still
      // open, and only then does the read run.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let markApplied!: () => void;
      const applied = new Promise<void>((resolve) => { markApplied = resolve; });
      const pending = db.transaction(async (tx) => {
        await tx.update(documentRevisions).set({ body: "tx1" }).where(eq(documentRevisions.id, revisionId));
        await tx.update(documents).set({ latestBody: "tx1", latestRevisionId: revisionId }).where(eq(documents.id, docId));
        markApplied();
        await gate;
      });
      try {
        await applied;
        const during = await issueAcceptanceSnapshotService(db).read(issueId);
        expect(during.document!.body).toBe("c1");
        expect(during.issue.version).toBe("6");
      } finally {
        release();
      }
      await pending;
      const after = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(after.document!.body).toBe("tx1");
      expect(after.issue.version).toBe("8");

      // Deleting the document cascades to its link row; the cascade delete
      // bumps the version and the snapshot loses the document.
      await db.delete(documents).where(eq(documents.id, docId));
      const cascaded = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(cascaded.document).toBeNull();
      expect(cascaded.issue.version).toBe("9");

      // Direct resets are forbidden: the epoch is trigger-managed and
      // monotonic; any writer trying to wind it back is rejected.
      await expect(
        sql.unsafe(`UPDATE "issue_acceptance_epochs" SET "epoch" = 1 WHERE "issue_id" = '${issueId}'`),
      ).rejects.toThrow();

      // Bigint generations are exact beyond 2^53: adjacent values stay
      // distinguishable where JS numbers would collapse.
      await sql.unsafe(`UPDATE "issue_acceptance_epochs" SET "epoch" = 9007199254740992 WHERE "issue_id" = '${issueId}'`);
      const big = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(big.issue.version).toBe("9007199254740992");
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "nested writers inside the bump chain all bump, and epochs survive delete/recreate and revision ABA (OPE-15145)",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-epoch-nest-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      const sql = db.$client as any;
      cleanups.push(async () => {
        await sql.end();
      });

      await db.insert(companies).values({ id: companyA, name: "Company A" });
      const issueId = randomUUID();
      const docId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task", identifier: "OPE-8501" });
      await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "v1", latestRevisionId: revisionId });
      await db.insert(documentRevisions).values({ id: revisionId, companyId: companyA, documentId: docId, revisionNumber: 1, body: "v1" });
      await db.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
      const read0 = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(read0.document!.body).toBe("v1");

      // A trigger nested INSIDE the epoch bump (ON the epoch table) performs
      // further capped bumps; every nested level must land (no guard state).
      await sql.unsafe(`
        CREATE FUNCTION nest_epoch_writer() RETURNS trigger AS $t$
        BEGIN
          IF NEW."epoch" < ${Number(read0.issue.version) + 3} THEN
            PERFORM "bump_issue_acceptance_epoch"(NEW."issue_id");
          END IF;
          RETURN NULL;
        END;
        $t$ LANGUAGE plpgsql;
        CREATE TRIGGER nest_epoch_trg
          AFTER UPDATE ON "issue_acceptance_epochs"
          FOR EACH ROW EXECUTE FUNCTION "nest_epoch_writer"();
      `);
      await sql.unsafe(`UPDATE "issue_acceptance_epochs" SET "epoch" = "epoch" + 1 WHERE "issue_id" = '${issueId}'`);
      const nested = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(BigInt(nested.issue.version)).toBe(BigInt(read0.issue.version) + 3n);

      // Revision-only ABA is visible: mutating and reverting a revision row
      // moves the epoch each time.
      const beforeRev = (await issueAcceptanceSnapshotService(db).read(issueId)).issue.version;
      await sql.unsafe(`UPDATE "document_revisions" SET "body" = 'tampered' WHERE "id" = '${revisionId}'`);
      const tampered = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(tampered.document).toBeNull();
      expect(BigInt(tampered.issue.version)).toBeGreaterThan(BigInt(beforeRev));
      await sql.unsafe(`UPDATE "document_revisions" SET "body" = 'v1' WHERE "id" = '${revisionId}'`);
      const reverted = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(reverted.document!.body).toBe("v1");
      expect(BigInt(reverted.issue.version)).toBeGreaterThan(BigInt(tampered.issue.version));

      // Direct epoch resets and deletes fail closed: winding back raises,
      // deleting restores the row at epoch+1.
      await expect(
        sql.unsafe(`UPDATE "issue_acceptance_epochs" SET "epoch" = 0 WHERE "issue_id" = '${issueId}'`),
      ).rejects.toThrow();
      await sql.unsafe(`DELETE FROM "issue_acceptance_epochs" WHERE "issue_id" = '${issueId}'`);
      const afterDelete = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(BigInt(afterDelete.issue.version)).toBeGreaterThan(BigInt(reverted.issue.version));

      // Deleting and recreating the issue with the same id and identifier
      // continues the epoch instead of returning to a previous value.
      const beforeRecreate = (await issueAcceptanceSnapshotService(db).read(issueId)).issue.version;
      await db.delete(documents).where(eq(documents.id, docId));
      await db.delete(issues).where(eq(issues.id, issueId));
      await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task", identifier: "OPE-8501" });
      const recreated = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(BigInt(recreated.issue.version)).toBeGreaterThan(BigInt(beforeRecreate));
      expect(recreated.document).toBeNull();
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "revision transfer bumps both owners, truncate fails closed, and non-acceptance docs do not bump (OPE-15145)",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-epoch-xfer-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      const sql = db.$client as any;
      cleanups.push(async () => {
        await sql.end();
      });

      await db.insert(companies).values({ id: companyA, name: "Company A" });
      const issueA = randomUUID();
      const issueB = randomUUID();
      const issueC = randomUUID();
      const docAccept = randomUUID();
      const docOther = randomUUID();
      const docB = randomUUID();
      const revA = randomUUID();
      for (const [id, identifier] of [[issueA, "OPE-8601"], [issueB, "OPE-8602"], [issueC, "OPE-8603"]] as const) {
        await db.insert(issues).values({ id, companyId: companyA, title: "Task", identifier });
      }
      await db.insert(documents).values({ id: docAccept, companyId: companyA, latestBody: "acc", latestRevisionId: revA });
      await db.insert(documentRevisions).values({ id: revA, companyId: companyA, documentId: docAccept, revisionNumber: 1, body: "acc" });
      await db.insert(issueDocuments).values({ companyId: companyA, issueId: issueA, documentId: docAccept, key: "acceptance-scenarios" });
      await db.insert(documents).values({ id: docOther, companyId: companyA, latestBody: "plan", latestRevisionId: randomUUID() });
      await db.insert(issueDocuments).values({ companyId: companyA, issueId: issueC, documentId: docOther, key: "plan" });
      await db.insert(documents).values({ id: docB, companyId: companyA, latestBody: "b", latestRevisionId: randomUUID() });
      await db.insert(issueDocuments).values({ companyId: companyA, issueId: issueB, documentId: docB, key: "acceptance-scenarios" });

      const versionOf = async (id: string) => (await issueAcceptanceSnapshotService(db).read(id))!.issue.version;

      // A revision row moved between documents bumps BOTH owners, exactly
      // once per hop; a B->A return cannot restore A's old pin.
      const pinA = await versionOf(issueA);
      await sql.unsafe(`UPDATE "document_revisions" SET "document_id" = '${docB}' WHERE "id" = '${revA}'`);
      expect(await versionOf(issueA)).not.toBe(pinA);
      const afterOut = await versionOf(issueA);
      await sql.unsafe(`UPDATE "document_revisions" SET "document_id" = '${docAccept}' WHERE "id" = '${revA}'`);
      expect(await versionOf(issueA)).not.toBe(pinA);
      expect(await versionOf(issueA)).not.toBe(afterOut);

      // Non-acceptance documents never move the epoch: a false invalidation
      // of an unrelated pin is a bug.
      const cPin = await versionOf(issueC);
      await db.update(documents).set({ latestBody: "plan v2" }).where(eq(documents.id, docOther));
      expect(await versionOf(issueC)).toBe(cPin);

      // Truncating the epoch table fails closed: generations survive and a
      // stale pin stays incompatible.
      const aBefore = await versionOf(issueA);
      await expect(sql.unsafe(`TRUNCATE "issue_acceptance_epochs"`)).rejects.toThrow();
      expect(await versionOf(issueA)).toBe(aBefore);
      expect(await versionOf(issueA)).not.toBe(pinA);
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "rolls back an explicit issue epoch bump together with a failed document write",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-bump-rollback-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      const client = db.$client;
      cleanups.push(async () => { await client.end(); });
      const issueId = randomUUID();
      const docId = randomUUID();
      await db.insert(companies).values({ id: companyA, name: "Company A" });
      await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task", identifier: "OPE-8803" });
      await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a" });
      const before = await issueAcceptanceSnapshotService(db).read(issueId);
      await expect(db.transaction(async (tx) => {
        await tx.execute(sqlTag`SELECT bump_issue_acceptance_epoch(${issueId}::uuid)`);
        await tx.update(documents).set({ latestBody: "b" }).where(eq(documents.id, docId));
        throw new Error("abort writer");
      })).rejects.toThrow("abort writer");
      const after = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(after!.issue.version).toBe(before!.issue.version);
      const [document] = await db.select({ body: documents.latestBody }).from(documents).where(eq(documents.id, docId));
      expect(document!.body).toBe("a");
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "rolls back a repeatable-read writer that bumps an issue after concurrent link creation",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-explicit-bump-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      cleanups.push(async () => { await db.$client.end(); });
      const issueId = randomUUID();
      const docId = randomUUID();
      await db.insert(companies).values({ id: companyA, name: "Company A" });
      await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task", identifier: "OPE-8804" });
      await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a" });

      let resume!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { resume = resolve; });
      const ready = new Promise<void>((resolve) => { started = resolve; });
      const writer = db.transaction(async (tx) => {
        await tx.execute(sqlTag`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
        await tx.execute(sqlTag`SELECT id FROM issues WHERE id = ${issueId}::uuid`);
        started();
        await gate;
        await tx.execute(sqlTag`SELECT bump_issue_acceptance_epoch(${issueId}::uuid)`);
        await tx.update(documents).set({ latestBody: "b" }).where(eq(documents.id, docId));
      });
      const outcome = writer.then(() => null, (error: unknown) => error);
      try {
        await ready;
        await db.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
      } finally {
        resume();
      }
      const error = await outcome;
      expect(error).not.toBeNull();
      expect(error).toMatchObject({ cause: { code: "40001" } });
      const [document] = await db.select({ body: documents.latestBody }).from(documents).where(eq(documents.id, docId));
      expect(document!.body).toBe("a");
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it.each([
    ["READ COMMITTED", "document"],
    ["READ COMMITTED", "revision"],
    ["REPEATABLE READ", "document"],
    ["REPEATABLE READ", "revision"],
  ] as const)(
    "explicit issue bump protects a %s %s writer after link creation",
    async (isolation, target) => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-explicit-overlap-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      cleanups.push(async () => { await db.$client.end(); });
      const issueId = randomUUID();
      const docId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(companies).values({ id: companyA, name: "Company A" });
      await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task" });
      await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a", latestRevisionId: revisionId });
      await db.insert(documentRevisions).values({ id: revisionId, companyId: companyA, documentId: docId, revisionNumber: 1, body: "a" });
      let resume!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { resume = resolve; });
      const ready = new Promise<void>((resolve) => { started = resolve; });
      const writer = db.transaction(async (tx) => {
        await tx.execute(isolation === "REPEATABLE READ"
          ? sqlTag`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`
          : sqlTag`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
        await tx.execute(sqlTag`SELECT id FROM issues WHERE id = ${issueId}::uuid`);
        started();
        await gate;
        await tx.execute(sqlTag`SELECT bump_issue_acceptance_epoch(${issueId}::uuid)`);
        if (target === "document") {
          await tx.update(documents).set({ latestBody: "b" }).where(eq(documents.id, docId));
          await tx.update(documents).set({ latestBody: "a" }).where(eq(documents.id, docId));
        } else {
          await tx.update(documentRevisions).set({ body: "b" }).where(eq(documentRevisions.id, revisionId));
          await tx.update(documentRevisions).set({ body: "a" }).where(eq(documentRevisions.id, revisionId));
        }
      });
      const outcome = writer.then(() => null, (error: unknown) => error);
      let version: string;
      try {
        await ready;
        await db.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
        version = (await issueAcceptanceSnapshotService(db).read(issueId))!.issue.version;
      } finally {
        resume();
      }
      const error = await outcome;
      const after = await issueAcceptanceSnapshotService(db).read(issueId);
      if (isolation === "REPEATABLE READ") {
        expect(error).toMatchObject({ cause: { code: "40001" } });
        expect(after!.issue.version).toBe(version!);
      } else {
        expect(error).toBeNull();
        expect(after!.issue.version).not.toBe(version!);
      }
      expect(after!.document!.body).toBe("a");
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it.each(["READ COMMITTED", "REPEATABLE READ"] as const)(
    "invalidates a pin when a %s document writer overlaps link creation",
    async (isolation) => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-link-race-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      const sql = db.$client as any;
      cleanups.push(async () => { await sql.end(); });
      const issueId = randomUUID();
      const docId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(companies).values({ id: companyA, name: "Company A" });
      await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task", identifier: "OPE-8801" });
      await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a", latestRevisionId: revisionId });
      await db.insert(documentRevisions).values({ id: revisionId, companyId: companyA, documentId: docId, revisionNumber: 1, body: "a" });

      let release!: () => void;
      let applied!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve) => { applied = resolve; });
      const writer = db.transaction(async (tx) => {
        await tx.execute(isolation === "REPEATABLE READ"
          ? sqlTag`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`
          : sqlTag`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
        await tx.update(documents).set({ latestBody: "b" }).where(eq(documents.id, docId));
        applied();
        await gate;
        await tx.update(documents).set({ latestBody: "a" }).where(eq(documents.id, docId));
      });
      let pin: Awaited<ReturnType<ReturnType<typeof issueAcceptanceSnapshotService>["read"]>>;
      try {
        await ready;
        await db.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
        pin = await issueAcceptanceSnapshotService(db).read(issueId);
        expect(pin!.document!.body).toBe("a");
      } finally {
        release();
      }
      await writer;
      const after = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(after!.issue.version).not.toBe(pin!.issue.version);
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it.each(["READ COMMITTED", "REPEATABLE READ"] as const)(
    "invalidates a pin when a %s revision writer overlaps link creation",
    async (isolation) => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-revision-race-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      const client = db.$client;
      cleanups.push(async () => { await client.end(); });
      const issueId = randomUUID();
      const docId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(companies).values({ id: companyA, name: "Company A" });
      await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task", identifier: "OPE-8802" });
      await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a", latestRevisionId: revisionId });
      await db.insert(documentRevisions).values({ id: revisionId, companyId: companyA, documentId: docId, revisionNumber: 1, body: "a" });

      let release!: () => void;
      let applied!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve) => { applied = resolve; });
      const writer = db.transaction(async (tx) => {
        await tx.execute(isolation === "REPEATABLE READ"
          ? sqlTag`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`
          : sqlTag`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
        await tx.update(documentRevisions).set({ body: "b" }).where(eq(documentRevisions.id, revisionId));
        applied();
        await gate;
        await tx.update(documentRevisions).set({ body: "a" }).where(eq(documentRevisions.id, revisionId));
      });
      let pin: Awaited<ReturnType<ReturnType<typeof issueAcceptanceSnapshotService>["read"]>>;
      try {
        await ready;
        await db.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
        pin = await issueAcceptanceSnapshotService(db).read(issueId);
        expect(pin!.document!.body).toBe("a");
      } finally {
        release();
      }
      await writer;
      const after = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(after!.issue.version).not.toBe(pin!.issue.version);
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it.each(["document", "revision"] as const)(
    "rejects or invalidates an old repeatable-read %s writer after concurrent linking",
    async (target) => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-old-writer-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      cleanups.push(async () => { await db.$client.end(); });
      const issueId = randomUUID();
      const docId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(companies).values({ id: companyA, name: "Company A" });
      await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task" });
      await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a", latestRevisionId: revisionId });
      await db.insert(documentRevisions).values({ id: revisionId, companyId: companyA, documentId: docId, revisionNumber: 1, body: "a" });

      let resume!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { resume = resolve; });
      const ready = new Promise<void>((resolve) => { started = resolve; });
      const writer = db.transaction(async (tx) => {
        await tx.execute(sqlTag`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
        await tx.execute(sqlTag`SELECT id FROM documents WHERE id = ${docId}::uuid`);
        started();
        await gate;
        if (target === "document") {
          await tx.update(documents).set({ latestBody: "b" }).where(eq(documents.id, docId));
          await tx.update(documents).set({ latestBody: "a" }).where(eq(documents.id, docId));
        } else {
          await tx.update(documentRevisions).set({ body: "b" }).where(eq(documentRevisions.id, revisionId));
          await tx.update(documentRevisions).set({ body: "a" }).where(eq(documentRevisions.id, revisionId));
        }
      });
      const outcome = writer.then(() => null, (error: unknown) => error);
      let pin: string;
      try {
        await ready;
        await db.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
        pin = (await issueAcceptanceSnapshotService(db).read(issueId))!.issue.version;
      } finally {
        resume();
      }
      const error = await outcome;
      const after = await issueAcceptanceSnapshotService(db).read(issueId);
      if (error) {
        expect(error).toMatchObject({ cause: { code: "40001" } });
      } else {
        expect(after!.issue.version).not.toBe(pin!);
      }
      expect(after!.document!.body).toBe("a");
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "rejects a link whose issue belongs to another company at the database boundary",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-foreign-issue-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      cleanups.push(async () => { await db.$client.end(); });
      const issueId = randomUUID();
      const docId = randomUUID();
      await db.insert(companies).values([
        { id: companyA, name: "Company A" },
        { id: companyB, name: "Company B", issuePrefix: "BBB" },
      ]);
      await db.insert(issues).values({ id: issueId, companyId: companyB, title: "Foreign issue" });
      await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "own" });
      await expect(db.insert(issueDocuments).values({
        companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios",
      })).rejects.toThrow();
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "rejects cross-company issue links and revision writes at the database boundary",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-tenant-boundary-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      cleanups.push(async () => { await db.$client.end(); });
      const issueId = randomUUID();
      const foreignDocId = randomUUID();
      const ownDocId = randomUUID();
      await db.insert(companies).values([
        { id: companyA, name: "Company A" },
        { id: companyB, name: "Company B", issuePrefix: "BBB" },
      ]);
      await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task" });
      await db.insert(documents).values([
        { id: foreignDocId, companyId: companyB, latestBody: "foreign" },
        { id: ownDocId, companyId: companyA, latestBody: "own" },
      ]);
      await expect(db.insert(issueDocuments).values({
        companyId: companyA, issueId, documentId: foreignDocId, key: "acceptance-scenarios",
      })).rejects.toThrow();
      await expect(db.insert(documentRevisions).values({
        companyId: companyB, documentId: ownDocId, revisionNumber: 1, body: "foreign",
      })).rejects.toThrow();
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it("invalidates the acceptance pin or rejects an old repeatable-read revision insert after linking", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-old-insert-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const issueId = randomUUID();
    const docId = randomUUID();
    await db.insert(companies).values({ id: companyA, name: "Company A" });
    await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task" });
    await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a" });

    let resume!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const writer = db.transaction(async (tx) => {
      await tx.execute(sqlTag`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      await tx.execute(sqlTag`SELECT id FROM documents WHERE id = ${docId}::uuid`);
      started();
      await gate;
      await tx.insert(documentRevisions).values({
        companyId: companyA, documentId: docId, revisionNumber: 1, body: "a",
      });
    });
    const outcome = writer.then(() => null, (error: unknown) => error);
    let pin: string;
    try {
      await ready;
      await db.insert(issueDocuments).values({
        companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios",
      });
      pin = (await issueAcceptanceSnapshotService(db).read(issueId))!.issue.version;
    } finally {
      resume();
    }
    const error = await outcome;
    const after = await issueAcceptanceSnapshotService(db).read(issueId);
    if (error) {
      expect(error).toMatchObject({ cause: { code: "40001" } });
    } else {
      expect(after!.issue.version).not.toBe(pin!);
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("fails closed when an old repeatable-read writer races a link with a foreign revision", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-foreign-race-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const issueId = randomUUID();
    const docId = randomUUID();
    await db.insert(companies).values([
      { id: companyA, name: "Company A" },
      { id: companyB, name: "Company B", issuePrefix: "BBB" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task" });
    await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a" });

    let resume!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const writer = db.transaction(async (tx) => {
      await tx.execute(sqlTag`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      await tx.execute(sqlTag`SELECT id FROM documents WHERE id = ${docId}::uuid`);
      started();
      await gate;
      await tx.insert(documentRevisions).values({
        companyId: companyB, documentId: docId, revisionNumber: 1, body: "foreign",
      });
    });
    const outcome = writer.then(() => null, (error: unknown) => error);
    try {
      await ready;
      await db.insert(issueDocuments).values({
        companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios",
      });
    } finally {
      resume();
    }
    expect(await outcome).not.toBeNull();
    expect(await db.select().from(documentRevisions).where(eq(documentRevisions.documentId, docId))).toHaveLength(0);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("rejects a foreign-company revision inserted after an acceptance link", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-foreign-new-revision-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const issueId = randomUUID();
    const docId = randomUUID();
    await db.insert(companies).values([
      { id: companyA, name: "Company A" },
      { id: companyB, name: "Company B", issuePrefix: "BBB" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task" });
    await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a" });
    await db.insert(issueDocuments).values({
      companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios",
    });
    const before = await issueAcceptanceSnapshotService(db).read(issueId);
    await expect(db.insert(documentRevisions).values({
      companyId: companyB, documentId: docId, revisionNumber: 1, body: "foreign",
    })).rejects.toThrow();
    expect(await issueAcceptanceSnapshotService(db).read(issueId)).toEqual(before);
    expect(await db.select().from(documentRevisions).where(eq(documentRevisions.documentId, docId))).toHaveLength(0);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("rejects linking a document with a pre-existing foreign-company revision", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-foreign-existing-revision-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const issueId = randomUUID();
    const docId = randomUUID();
    await db.insert(companies).values([
      { id: companyA, name: "Company A" },
      { id: companyB, name: "Company B", issuePrefix: "BBB" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task" });
    await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a" });
    await db.insert(documentRevisions).values({
      companyId: companyB, documentId: docId, revisionNumber: 1, body: "foreign",
    });
    await expect(db.insert(issueDocuments).values({
      companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios",
    })).rejects.toThrow();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("rejects a supported writer reaching a foreign-company document", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-service-tenant-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const issueId = randomUUID();
    const docId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(companies).values([
      { id: companyA, name: "Company A" },
      { id: companyB, name: "Company B", issuePrefix: "BBB" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task" });
    await db.insert(documents).values({ id: docId, companyId: companyB, latestBody: "foreign", latestRevisionId: revisionId });
    await db.insert(documentRevisions).values({ id: revisionId, companyId: companyB, documentId: docId, revisionNumber: 1, body: "foreign" });
    await db.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
    await expect(documentService(db).upsertIssueDocument({
      issueId, key: "acceptance-scenarios", format: "markdown", body: "changed", baseRevisionId: revisionId,
    })).rejects.toThrow();
    const [foreign] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(foreign!.latestBody).toBe("foreign");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("fails closed when an explicit acceptance bump names a nonexistent issue", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-missing-issue-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const missingIssueId = randomUUID();
    await expect(db.execute(sqlTag`SELECT bump_issue_acceptance_epoch(${missingIssueId}::uuid)`)).rejects.toThrow();
    const rows = await db.execute(sqlTag`SELECT issue_id FROM issue_acceptance_epochs WHERE issue_id = ${missingIssueId}::uuid`);
    expect(rows).toHaveLength(0);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("rolls back a newly linked acceptance document and its epoch together", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-link-rollback-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const issueId = randomUUID();
    const docId = randomUUID();
    await db.insert(companies).values({ id: companyA, name: "Company A" });
    await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task" });
    await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a" });
    const before = await issueAcceptanceSnapshotService(db).read(issueId);
    await expect(db.transaction(async (tx) => {
      await tx.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
      throw new Error("abort link");
    })).rejects.toThrow("abort link");
    expect(await issueAcceptanceSnapshotService(db).read(issueId)).toEqual(before);
    expect(await db.select().from(issueDocuments).where(eq(issueDocuments.issueId, issueId))).toHaveLength(0);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("does not commit a cross-company graph when a link races an issue company move", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-company-race-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const issueId = randomUUID();
    const docId = randomUUID();
    await db.insert(companies).values([
      { id: companyA, name: "Company A" },
      { id: companyB, name: "Company B", issuePrefix: "BBB" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task" });
    await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a" });
    let release!: () => void;
    let linked!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { linked = resolve; });
    const link = db.transaction(async (tx) => {
      await tx.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
      linked();
      await gate;
    });
    await ready;
    const move = db.update(issues).set({ companyId: companyB }).where(eq(issues.id, issueId)).then(() => null, (error: unknown) => error);
    release();
    await link;
    expect(await move).not.toBeNull();
    const [row] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId));
    expect(row!.companyId).toBe(companyA);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it.each(["issue", "document"] as const)(
    "rejects changing the company of a linked %s at the database boundary",
    async (target) => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-company-move-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      cleanups.push(async () => { await db.$client.end(); });
      const issueId = randomUUID();
      const docId = randomUUID();
      await db.insert(companies).values([
        { id: companyA, name: "Company A" },
        { id: companyB, name: "Company B", issuePrefix: "BBB" },
      ]);
      await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task" });
      await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a" });
      await db.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
      const before = await issueAcceptanceSnapshotService(db).read(issueId);
      const move = target === "issue"
        ? db.update(issues).set({ companyId: companyB }).where(eq(issues.id, issueId))
        : db.update(documents).set({ companyId: companyB }).where(eq(documents.id, docId));
      await expect(move).rejects.toThrow();
      expect(await issueAcceptanceSnapshotService(db).read(issueId)).toEqual(before);
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "epoch rows are immutable: re-keying fails closed and company ABA invalidates the pin (OPE-15145)",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-epoch-pk-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      const sql = db.$client as any;
      cleanups.push(async () => {
        await sql.end();
      });

      await db.insert(companies).values([
        { id: companyA, name: "Company A" },
        { id: companyB, name: "Company B", issuePrefix: "BBB" },
      ]);
      const issueX = randomUUID();
      const docId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(issues).values({ id: issueX, companyId: companyA, title: "Task", identifier: "OPE-8701" });
      await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "v1", latestRevisionId: revisionId });
      await db.insert(documentRevisions).values({ id: revisionId, companyId: companyA, documentId: docId, revisionNumber: 1, body: "v1" });
      await db.insert(issueDocuments).values({ companyId: companyA, issueId: issueX, documentId: docId, key: "acceptance-scenarios" });
      const pinX = await issueAcceptanceSnapshotService(db).read(issueX);
      const freeY = randomUUID();

      // Moving an existing epoch row to another issue id must be rejected;
      // otherwise a PK shuffle plus a company A->B->A could hand a stale
      // pin its old snapshot back.
      await expect(
        sql.unsafe(`UPDATE "issue_acceptance_epochs" SET "issue_id" = '${freeY}' WHERE "issue_id" = '${issueX}'`),
      ).rejects.toThrow();
      expect(
        (await sql.unsafe(`SELECT "issue_id" FROM "issue_acceptance_epochs" WHERE "issue_id" = '${issueX}'`)).length,
      ).toBe(1);

      // Company A->B->A invalidates the pin even though every identity field
      // returns to its old value.
      await db.update(issues).set({ companyId: companyB }).where(eq(issues.id, issueX));
      await db.update(issues).set({ companyId: companyA }).where(eq(issues.id, issueX));
      const after = await issueAcceptanceSnapshotService(db).read(issueX);
      expect(after.issue.version).not.toBe(pinX.issue.version);
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});