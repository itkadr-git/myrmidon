import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql as sqlTag } from "drizzle-orm";
import { createDb } from "@myrmidon/db";
import {
  agents,
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
  it("preserves acceptance documents and revisions when their agent is deleted", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("acceptance-agent-delete-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const agentId = randomUUID();
    const revisionAgentId = randomUUID();
    const issueId = randomUUID();
    const docId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(companies).values({ id: companyA, name: "A" });
    await db.insert(agents).values([{ id: agentId, companyId: companyA, name: "Author", role: "engineer" }, { id: revisionAgentId, companyId: companyA, name: "Revision author", role: "engineer" }]);
    await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task", identifier: "OPE-15217" });
    await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "criteria", latestRevisionId: revisionId, latestRevisionNumber: 1, createdByAgentId: agentId, updatedByAgentId: agentId });
    await db.insert(documentRevisions).values({ id: revisionId, documentId: docId, companyId: companyA, revisionNumber: 1, body: "criteria", createdByAgentId: revisionAgentId });
    await db.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
    const before = await issueAcceptanceSnapshotService(db).read(issueId);
    await db.delete(agents);
    const [doc] = await db.select().from(documents).where(eq(documents.id, docId));
    const [revision] = await db.select().from(documentRevisions).where(eq(documentRevisions.id, revisionId));
    expect(doc?.createdByAgentId).toBeNull();
    expect(doc?.updatedByAgentId).toBeNull();
    expect(revision?.createdByAgentId).toBeNull();
    const after = await issueAcceptanceSnapshotService(db).read(issueId);
    expect(after?.document).toEqual(before?.document);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("fences a stale issue writer when its document author is deleted", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("acceptance-agent-delete-fence-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const agentId = randomUUID();
    const issueId = randomUUID();
    const docId = randomUUID();
    await db.insert(companies).values({ id: companyA, name: "A" });
    await db.insert(agents).values({ id: agentId, companyId: companyA, name: "Author", role: "engineer" });
    await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task" });
    await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "criteria", createdByAgentId: agentId });
    await db.insert(documentRevisions).values({ documentId: docId, companyId: companyA, revisionNumber: 1, body: "criteria", createdByAgentId: agentId });
    await db.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
    let resume!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const writer = db.transaction(async (tx) => {
      await tx.execute(sqlTag`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      await tx.execute(sqlTag`SELECT id FROM issues WHERE id = ${issueId}::uuid`);
      started();
      await gate;
      await tx.update(issues).set({ title: "stale" }).where(eq(issues.id, issueId));
    });
    const outcome = writer.then(() => null, (error: unknown) => error);
    try {
      await ready;
      await db.delete(agents).where(eq(agents.id, agentId));
    } finally {
      resume();
    }
    expect(await outcome).toMatchObject({ cause: { code: "40001" } });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.title).toBe("Task");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("deletes the author of an unlinked document with multiple revisions", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("revision-agent-delete-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const agentId = randomUUID();
    const docId = randomUUID();
    await db.insert(companies).values({ id: companyA, name: "A" });
    await db.insert(agents).values({ id: agentId, companyId: companyA, name: "Author", role: "engineer" });
    await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "second", createdByAgentId: agentId, updatedByAgentId: agentId });
    await db.insert(documentRevisions).values([
      { documentId: docId, companyId: companyA, revisionNumber: 1, body: "first", createdByAgentId: agentId },
      { documentId: docId, companyId: companyA, revisionNumber: 2, body: "second", createdByAgentId: agentId },
    ]);
    await db.delete(agents).where(eq(agents.id, agentId));
    const [document] = await db.select().from(documents).where(eq(documents.id, docId));
    const revisions = await db.select().from(documentRevisions).where(eq(documentRevisions.documentId, docId));
    expect(document?.latestBody).toBe("second");
    expect(document?.createdByAgentId).toBeNull();
    expect(revisions).toHaveLength(2);
    expect(revisions.every((revision) => revision.createdByAgentId === null)).toBe(true);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("cleans up agents and companies after deleting linked issues", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("acceptance-cascade-delete-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const seed = async (companyId: string) => {
      const agentId = randomUUID();
      const issueId = randomUUID();
      const docId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Cascade" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Author", role: "engineer" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Task" });
      await db.insert(documents).values({ id: docId, companyId, latestBody: "criteria", latestRevisionId: revisionId, createdByAgentId: agentId, updatedByAgentId: agentId });
      await db.insert(documentRevisions).values({ id: revisionId, documentId: docId, companyId, revisionNumber: 1, body: "criteria", createdByAgentId: agentId });
      await db.insert(issueDocuments).values({ companyId, issueId, documentId: docId, key: "acceptance-scenarios" });
      return { agentId, issueId, docId, revisionId };
    };
    const first = await seed(companyA);
    await db.delete(issues).where(eq(issues.id, first.issueId));
    const otherAgent = randomUUID();
    await db.insert(agents).values({ id: otherAgent, companyId: companyA, name: "Other", role: "engineer" });
    await db.update(documentRevisions).set({ createdByAgentId: otherAgent }).where(eq(documentRevisions.id, first.revisionId));
    await db.delete(agents).where(eq(agents.companyId, companyA));
    expect((await db.select().from(documents).where(eq(documents.id, first.docId)))[0]?.createdByAgentId).toBeNull();
    expect((await db.select().from(documentRevisions).where(eq(documentRevisions.id, first.revisionId)))[0]?.createdByAgentId).toBeNull();
    await db.delete(companies).where(eq(companies.id, companyA));
    const second = await seed(companyB);
    await db.delete(issues).where(eq(issues.id, second.issueId));
    await db.delete(agents).where(eq(agents.id, second.agentId));
    await db.insert(documentRevisions).values({ documentId: second.docId, companyId: companyB, revisionNumber: 2, body: "second" });
    await db.delete(companies).where(eq(companies.id, companyB));
    expect(await db.select().from(documents).where(eq(documents.id, second.docId))).toHaveLength(0);
    expect(await db.select().from(documentRevisions).where(eq(documentRevisions.documentId, second.docId))).toHaveLength(0);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

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
        issue: { id: issue!.id, identifier: "OPE-7001", companyId: companyA, version: expect.stringMatching(/^[1-9]\d*$/) },
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

      const scoped = issueAcceptanceSnapshotService(db);
      expect(await scoped.read(issue!.id, companyA)).toEqual(withDocument);
      expect(await scoped.read("OPE-7001", companyA)).toEqual(withDocument);
      expect(await scoped.read(issue!.id, companyB)).toBeNull();
      expect(await scoped.read("OPE-7001", companyB)).toBeNull();

      const missing = await issueAcceptanceSnapshotService(db).read(randomUUID());
      expect(missing).toBeNull();
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "independently rejects a corrupted cross-company document link on read",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-corrupt-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      const client = db.$client;
      cleanups.push(async () => { await (client as any).end(); });
      const issueId = randomUUID();
      const docId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(companies).values([
        { id: companyA, name: "A", issuePrefix: "AAA" },
        { id: companyB, name: "B", issuePrefix: "BBB" },
      ]);
      await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task", identifier: "OPE-7999" });
      await db.insert(documents).values({ id: docId, companyId: companyB, latestBody: "foreign secret", latestRevisionId: revisionId, latestRevisionNumber: 1 });
      await db.insert(documentRevisions).values({ id: revisionId, companyId: companyB, documentId: docId, revisionNumber: 1, body: "foreign secret" });
      // Simulate preexisting corruption, not a supported application writer.
      // Keep the bypass transaction-local so the ordinary protocol stays enabled.
      await db.transaction(async (tx) => {
        await tx.execute(sqlTag`SET LOCAL session_replication_role = replica`);
        await tx.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
      });
      const snapshot = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(snapshot?.issue.companyId).toBe(companyA);
      expect(snapshot?.document).toBeNull();
      // A scoped service read must distinguish a corrupt link from no document.
      await expect(issueAcceptanceSnapshotService(db).read(issueId, companyA)).rejects.toThrow("Ambiguous acceptance snapshot");
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "rejects a published revision whose number disagrees with the document",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-revision-number-");
      cleanups.push(() => dbh.cleanup());
      const db = createDb(dbh.connectionString);
      cleanups.push(async () => { await db.$client.end(); });
      const issueId = randomUUID();
      const documentId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(companies).values({ id: companyA, name: "A" });
      await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task", identifier: "OPE-7998" });
      await db.insert(documents).values({ id: documentId, companyId: companyA, latestBody: "criteria", latestRevisionId: revisionId, latestRevisionNumber: 2 });
      await db.insert(documentRevisions).values({ id: revisionId, companyId: companyA, documentId, revisionNumber: 1, body: "criteria" });
      await db.insert(issueDocuments).values({ companyId: companyA, issueId, documentId, key: "acceptance-scenarios" });
      await expect(issueAcceptanceSnapshotService(db).read(issueId, companyA)).rejects.toThrow("Ambiguous acceptance snapshot");
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
      // The DB boundary must reject a company B link to company A's issue.
      await db.insert(documents).values({
        id: foreignDocId,
        companyId: companyB,
        latestBody: "foreign criteria",
        latestRevisionId: randomUUID(),
      });
      await expect(db.insert(issueDocuments).values({
        companyId: companyB,
        issueId: issue!.id,
        documentId: foreignDocId,
        key: "acceptance-scenarios",
      })).rejects.toThrow();

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
      await expect(db.insert(issueDocuments).values({
        companyId: companyA,
        issueId: issue!.id,
        documentId: foreignDocId,
        key: "acceptance-scenarios",
      })).rejects.toThrow();

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
        issue: { id: healthy.id, identifier: "OPE-8201", companyId: companyA, version: expect.stringMatching(/^[1-9]\d*$/) },
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

      // A revision cannot be moved to another company even by an old writer.
      const foreignRevision = await seedGraph("OPE-8203", async ({ revisionId }) => {
        await expect(db.update(documentRevisions)
          .set({ companyId: companyB })
          .where(eq(documentRevisions.id, revisionId))).rejects.toThrow();
      });
      expect((await issueAcceptanceSnapshotService(db).read(foreignRevision.id))!.document).not.toBeNull();

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
      let previous = await versionOf();
      expect(BigInt(previous)).toBeGreaterThan(1n);
      const expectBump = async () => {
        const next = await versionOf();
        expect(BigInt(next)).toBeGreaterThan(BigInt(previous));
        previous = next;
      };

      // Identity A->B->A still moves the version twice.
      await db.update(issues).set({ identifier: "OPE-8301-TMP" }).where(eq(issues.id, issue!.id));
      await expectBump();
      await db.update(issues).set({ identifier: "OPE-8301" }).where(eq(issues.id, issue!.id));
      await expectBump();

      // Moving a linked issue between companies must fail closed.
      await db.insert(companies).values({ id: companyB, name: "Company B", issuePrefix: "BBB" });
      await expect(db.update(issues).set({ companyId: companyB }).where(eq(issues.id, issue!.id))).rejects.toThrow();
      expect(await versionOf()).toBe(previous);

      // A bound-document update bumps through the documents trigger.
      await db.update(documents).set({ latestBody: "v2" }).where(eq(documents.id, docId));
      await expectBump();

      // Link delete bumps (a delete+recreate is a visible mutation).
      await db.delete(issueDocuments).where(eq(issueDocuments.documentId, docId));
      await expectBump();
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
      const initialVersion = BigInt(await versionOf());
      expect(initialVersion).toBeGreaterThan(1n);

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
      const nestedVersion = BigInt(await versionOf());
      expect(nestedVersion).toBeGreaterThan(initialVersion);

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
      const concurrentVersion = BigInt(await versionOf());
      expect(concurrentVersion - nestedVersion).toBeGreaterThanOrEqual(3n);

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
        expect(BigInt(during.issue.version)).toBe(concurrentVersion);
      } finally {
        release();
      }
      await pending;
      const after = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(after.document!.body).toBe("tx1");
      expect(BigInt(after.issue.version) - concurrentVersion).toBeGreaterThanOrEqual(2n);

      // Deleting the document cascades to its link row; the cascade delete
      // bumps the version and the snapshot loses the document.
      await db.delete(documents).where(eq(documents.id, docId));
      const cascaded = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(cascaded.document).toBeNull();
      expect(BigInt(cascaded.issue.version)).toBeGreaterThan(BigInt(after.issue.version));

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

  it("fences a stale issue writer when a linked document changes", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-direct-issue-fence-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const issueId = randomUUID();
    const docId = randomUUID();
    await db.insert(companies).values({ id: companyA, name: "Company A" });
    await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task" });
    await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a" });
    await db.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
    let resume!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const writer = db.transaction(async (tx) => {
      await tx.execute(sqlTag`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      await tx.execute(sqlTag`SELECT id FROM issues WHERE id = ${issueId}::uuid`);
      started();
      await gate;
      await tx.update(issues).set({ title: "stale" }).where(eq(issues.id, issueId));
    });
    const outcome = writer.then(() => null, (error: unknown) => error);
    try {
      await ready;
      await db.update(documents).set({ latestBody: "b" }).where(eq(documents.id, docId));
    } finally {
      resume();
    }
    expect(await outcome).toMatchObject({ cause: { code: "40001" } });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

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
      const before = await issueAcceptanceSnapshotService(db).read(issueId);
      await ready;
      // Linking waits for the writer's document lock. Release the writer before
      // awaiting the link; awaiting it first would deadlock this test's gate.
      const link = db.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
      const linking = Promise.resolve(link);
      release();
      await Promise.all([writer, linking]);
      const after = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(after!.document!.body).toBe("a");
      expect(after!.issue.version).not.toBe(before!.issue.version);
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
      const before = await issueAcceptanceSnapshotService(db).read(issueId);
      await ready;
      // Linking waits for the writer's document lock. Release the writer before
      // awaiting the link; awaiting it first would deadlock this test's gate.
      const link = db.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
      const linking = Promise.resolve(link);
      release();
      await Promise.all([writer, linking]);
      const after = await issueAcceptanceSnapshotService(db).read(issueId);
      expect(after!.document!.body).toBe("a");
      expect(after!.issue.version).not.toBe(before!.issue.version);
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

  it("rejects moving a linked acceptance document to a foreign company", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-document-company-move-");
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
    await expect(db.update(documents).set({ companyId: companyB }).where(eq(documents.id, docId)))
      .rejects.toThrow();
    const [document] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(document!.companyId).toBe(companyA);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

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
    // The DB boundary rejects the invalid revision before a link can exist.
    await expect(db.insert(documentRevisions).values({
      companyId: companyB, documentId: docId, revisionNumber: 1, body: "foreign",
    })).rejects.toThrow();
    expect(await db.select().from(documentRevisions).where(eq(documentRevisions.documentId, docId))).toHaveLength(0);
    await db.insert(issueDocuments).values({
      companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios",
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("rejects linking a foreign-company document before a supported writer can reach it", async () => {
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
    // The database rejects the cross-tenant graph before any service writer can reach it.
    await expect(db.insert(issueDocuments).values({
      companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios",
    })).rejects.toThrow();
    expect(await db.select().from(issueDocuments).where(eq(issueDocuments.issueId, issueId))).toHaveLength(0);
    const [foreign] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(foreign!.latestBody).toBe("foreign");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("allows deleting an issue with a linked acceptance document", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-issue-delete-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const issueId = randomUUID();
    const docId = randomUUID();
    await db.insert(companies).values({ id: companyA, name: "Company A" });
    await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task" });
    await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a" });
    await db.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
    await db.delete(issues).where(eq(issues.id, issueId));
    expect(await db.select().from(issueDocuments).where(eq(issueDocuments.issueId, issueId))).toHaveLength(0);
    const rows = await db.execute(sqlTag`SELECT acceptance_issue_id FROM documents WHERE id = ${docId}::uuid`);
    expect(rows[0]).toMatchObject({ acceptance_issue_id: null });
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

  it("binds the acceptance document directly to its company and issue within the link transaction", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-direct-binding-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const issueId = randomUUID();
    const docId = randomUUID();
    await db.insert(companies).values({ id: companyA, name: "Company A" });
    await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task" });
    await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a" });
    await db.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
    const rows = await db.execute(sqlTag`SELECT acceptance_issue_id FROM documents WHERE id = ${docId}::uuid AND company_id = ${companyA}::uuid`);
    expect(rows[0]).toMatchObject({ acceptance_issue_id: issueId });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("rejects clearing a linked document owner outside the link protocol", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-owner-bypass-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const issueId = randomUUID();
    const docId = randomUUID();
    await db.insert(companies).values({ id: companyA, name: "Company A" });
    await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task" });
    await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a" });
    await db.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
    await expect(db.execute(sqlTag`UPDATE documents SET acceptance_issue_id = NULL WHERE id = ${docId}::uuid`)).rejects.toThrow();
    const rows = await db.execute(sqlTag`SELECT acceptance_issue_id FROM documents WHERE id = ${docId}::uuid`);
    expect(rows[0]).toMatchObject({ acceptance_issue_id: issueId });
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
    const rows = await db.execute(sqlTag`SELECT acceptance_issue_id FROM documents WHERE id = ${docId}::uuid`);
    expect(rows[0]).toMatchObject({ acceptance_issue_id: null });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("rejects binding one acceptance document to two issues", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-double-link-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const issueA = randomUUID();
    const issueB = randomUUID();
    const docId = randomUUID();
    await db.insert(companies).values({ id: companyA, name: "Company A" });
    await db.insert(issues).values([
      { id: issueA, companyId: companyA, title: "A" },
      { id: issueB, companyId: companyA, title: "B" },
    ]);
    await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a" });
    await db.insert(issueDocuments).values({ companyId: companyA, issueId: issueA, documentId: docId, key: "acceptance-scenarios" });
    await expect(db.insert(issueDocuments).values({ companyId: companyA, issueId: issueB, documentId: docId, key: "acceptance-scenarios" })).rejects.toThrow();
    const [link] = await db.select().from(issueDocuments).where(eq(issueDocuments.documentId, docId));
    expect(link!.issueId).toBe(issueA);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("serializes concurrent acceptance links to the same document", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-concurrent-link-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const issueA = randomUUID();
    const issueB = randomUUID();
    const docId = randomUUID();
    await db.insert(companies).values({ id: companyA, name: "Company A" });
    await db.insert(issues).values([
      { id: issueA, companyId: companyA, title: "A" },
      { id: issueB, companyId: companyA, title: "B" },
    ]);
    await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a" });
    let release!: () => void;
    let linked!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { linked = resolve; });
    const first = db.transaction(async (tx) => {
      await tx.insert(issueDocuments).values({ companyId: companyA, issueId: issueA, documentId: docId, key: "acceptance-scenarios" });
      linked();
      await gate;
    });
    await ready;
    const second = db.insert(issueDocuments).values({ companyId: companyA, issueId: issueB, documentId: docId, key: "acceptance-scenarios" }).then(() => null, (error: unknown) => error);
    release();
    await first;
    expect(await second).not.toBeNull();
    const links = await db.select().from(issueDocuments).where(eq(issueDocuments.documentId, docId));
    expect(links).toHaveLength(1);
    expect(links[0]!.issueId).toBe(issueA);
    const rows = await db.execute(sqlTag`SELECT acceptance_issue_id FROM documents WHERE id = ${docId}::uuid`);
    expect(rows[0]).toMatchObject({ acceptance_issue_id: issueA });
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

  it("fences a stale issue writer after an acceptance link is deleted", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-unlink-fence-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const issueId = randomUUID();
    const docId = randomUUID();
    await db.insert(companies).values({ id: companyA, name: "Company A" });
    await db.insert(issues).values({ id: issueId, companyId: companyA, title: "Task" });
    await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a" });
    await db.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
    let resume!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const writer = db.transaction(async (tx) => {
      await tx.execute(sqlTag`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      await tx.execute(sqlTag`SELECT id FROM issues WHERE id = ${issueId}::uuid`);
      started();
      await gate;
      await tx.update(issues).set({ title: "Stale writer" }).where(eq(issues.id, issueId));
    });
    const outcome = writer.then(() => null, (error: unknown) => error);
    try {
      await ready;
      await db.delete(issueDocuments).where(eq(issueDocuments.documentId, docId));
    } finally {
      resume();
    }
    expect(await outcome).toMatchObject({ cause: { code: "40001" } });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("fences a stale old-issue writer after an acceptance link transfer", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-transfer-fence-");
    cleanups.push(() => dbh.cleanup());
    const db = createDb(dbh.connectionString);
    cleanups.push(async () => { await db.$client.end(); });
    const oldIssue = randomUUID();
    const newIssue = randomUUID();
    const docId = randomUUID();
    await db.insert(companies).values({ id: companyA, name: "Company A" });
    await db.insert(issues).values([
      { id: oldIssue, companyId: companyA, title: "Old" },
      { id: newIssue, companyId: companyA, title: "New" },
    ]);
    await db.insert(documents).values({ id: docId, companyId: companyA, latestBody: "a" });
    await db.insert(issueDocuments).values({ companyId: companyA, issueId: oldIssue, documentId: docId, key: "acceptance-scenarios" });
    let resume!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const writer = db.transaction(async (tx) => {
      await tx.execute(sqlTag`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      await tx.execute(sqlTag`SELECT id FROM issues WHERE id = ${oldIssue}::uuid`);
      started();
      await gate;
      await tx.update(issues).set({ title: "Stale writer" }).where(eq(issues.id, oldIssue));
    });
    const outcome = writer.then(() => null, (error: unknown) => error);
    try {
      await ready;
      await db.update(issueDocuments).set({ issueId: newIssue }).where(eq(issueDocuments.documentId, docId));
    } finally {
      resume();
    }
    expect(await outcome).toMatchObject({ cause: { code: "40001" } });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("rejects a stale repeatable-read issue company move after a concurrent link", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("issue-acceptance-stale-company-move-");
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
      await tx.execute(sqlTag`SELECT id FROM issues WHERE id = ${issueId}::uuid`);
      started();
      await gate;
      await tx.update(issues).set({ companyId: companyB }).where(eq(issues.id, issueId));
    });
    const outcome = writer.then(() => null, (error: unknown) => error);
    try {
      await ready;
      await db.insert(issueDocuments).values({ companyId: companyA, issueId, documentId: docId, key: "acceptance-scenarios" });
    } finally {
      resume();
    }
    expect(await outcome).not.toBeNull();
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue!.companyId).toBe(companyA);
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

      // Company ABA is permitted only after unlinking; each transition must
      // invalidate the original pin, including when the graph is restored.
      await db.delete(issueDocuments).where(eq(issueDocuments.issueId, issueX));
      await db.update(issues).set({ companyId: companyB }).where(eq(issues.id, issueX));
      await db.update(issues).set({ companyId: companyA }).where(eq(issues.id, issueX));
      await db.insert(issueDocuments).values({ companyId: companyA, issueId: issueX, documentId: docId, key: "acceptance-scenarios" });
      const after = await issueAcceptanceSnapshotService(db).read(issueX);
      expect(after.document).toEqual(pinX.document);
      expect(after.issue.version).not.toBe(pinX.issue.version);
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});