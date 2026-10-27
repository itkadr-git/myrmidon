import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueRelations, issues, type Db } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { BLOCKED_GRAPH_QUERY_LIMIT, loadBlockedGraph } from "./load-edges.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("loadBlockedGraph (P1.10)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const rootId = randomUUID();
  const doneRootId = randomUUID();
  const cancelledRootId = randomUUID();
  const blockedId = randomUUID();
  const metadataId = randomUUID();
  const freeId = randomUUID();
  const orphanId = randomUUID();
  const blockedSince = new Date("2026-01-02T03:04:05.000Z");
  const metadata = {
    blockReason: "dependency" as const,
    owner: { userId: "team-a" },
    nextCheckAt: "2026-01-03T00:00:00.000Z",
    timeoutAt: "2026-01-09T00:00:00.000Z",
    escalationPolicy: "notify_owner",
  };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-blocked-graph-");
    const observedQueries: string[] = [];
    db = createDb(database.connectionString, { onQuery: (query) => observedQueries.push(query) });
    await db.insert(companies).values([
      { id: companyId, name: "Blocker Graph Co", issuePrefix: "BGC" },
      { id: otherCompanyId, name: "Other Blocker Graph Co", issuePrefix: "OBG" },
    ]);
    await db.insert(issues).values([
      { id: rootId, companyId, title: "Open blocker", status: "todo" },
      { id: doneRootId, companyId, title: "Done blocker", status: "done" },
      { id: cancelledRootId, companyId, title: "Cancelled blocker", status: "cancelled" },
      { id: blockedId, companyId, title: "Blocked issue", status: "blocked" },
      {
        id: metadataId,
        companyId,
        title: "Blocked issue with metadata",
        status: "blocked",
        blockerMetadata: metadata,
        blockedTransitionAt: blockedSince,
      },
      { id: freeId, companyId, title: "Issue without blockers", status: "todo" },
      { id: orphanId, companyId, title: "Blocked without edges", status: "blocked" },
      { id: randomUUID(), companyId: otherCompanyId, title: "Other blocked issue", status: "blocked" },
      { id: randomUUID(), companyId: otherCompanyId, title: "Other company blocker", status: "todo" },
    ]);
    await db.insert(issueRelations).values([
      { companyId, issueId: rootId, relatedIssueId: blockedId, type: "blocks" },
      { companyId, issueId: doneRootId, relatedIssueId: blockedId, type: "blocks" },
      { companyId, issueId: cancelledRootId, relatedIssueId: metadataId, type: "blocks" },
      { companyId: otherCompanyId, issueId: rootId, relatedIssueId: metadataId, type: "blocks" },
    ]);
    observedQueries.length = 0;
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  }, 60_000);

  it("loads all company blocked issues independently of open edges in two queries", async () => {
    const observedQueries: string[] = [];
    const observedDb = createDb(database.connectionString, { onQuery: (query) => observedQueries.push(query) });
    try {
      const result = await loadBlockedGraph(observedDb, companyId);
      const edgeQueries = observedQueries.filter((query) => /from\s+"?issue_relations"?/i.test(query));

      expect(edgeQueries).toHaveLength(1);
      expect(observedQueries).toHaveLength(2);
      expect(result.edges).toEqual([
        { blockedId, blockerId: rootId, blockerStatus: "todo" },
      ]);
      expect(result.blockedIssues).toEqual([
        { id: blockedId, status: "blocked", blockerMetadata: null, blockedSince: null },
        { id: metadataId, status: "blocked", blockerMetadata: metadata, blockedSince },
        { id: orphanId, status: "blocked", blockerMetadata: null, blockedSince: null },
      ].sort((a, b) => a.id.localeCompare(b.id)));
      expect(result.truncated).toEqual({ edges: false, blockedIssues: false });
    } finally {
      await observedDb.$client.end();
    }
  });

  it("includes blocker metadata and blocked timestamp for a dependent with an open blocker", async () => {
    await db.insert(issueRelations).values({
      companyId,
      issueId: rootId,
      relatedIssueId: metadataId,
      type: "blocks",
    });
    const result = await loadBlockedGraph(db, companyId);
    expect(result.edges).toContainEqual({ blockedId: metadataId, blockerId: rootId, blockerStatus: "todo" });
    expect(result.blockedIssues).toContainEqual({
      id: metadataId,
      status: "blocked",
      blockerMetadata: metadata,
      blockedSince,
    });
    expect(result.blockedIssues).not.toContainEqual(expect.objectContaining({ id: freeId }));
  });

  it("loads an edge-free company and reports deterministic independent truncation", async () => {
    const limitCompanyId = randomUUID();
    await db.insert(companies).values({ id: limitCompanyId, name: "Limit Co", issuePrefix: "LIM" });
    expect(await loadBlockedGraph(db, limitCompanyId)).toEqual({
      edges: [], blockedIssues: [], truncated: { edges: false, blockedIssues: false },
    });
    const ids = Array.from({ length: BLOCKED_GRAPH_QUERY_LIMIT + 1 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    await db.insert(issues).values(ids.map((id) => ({
      id, companyId: limitCompanyId, title: "Blocked without edge", status: "blocked",
    })));
    const queries: string[] = [];
    const observedDb = createDb(database.connectionString, { onQuery: (query) => queries.push(query) });
    try {
      const withoutEdges = await loadBlockedGraph(observedDb, limitCompanyId);
      expect(withoutEdges.blockedIssues.map((issue) => issue.id)).toEqual(ids.slice(0, BLOCKED_GRAPH_QUERY_LIMIT));
      expect(withoutEdges.truncated).toEqual({ edges: false, blockedIssues: true });
      expect(queries).toHaveLength(2);
      const limitRootId = randomUUID();
      await db.insert(issues).values({ id: limitRootId, companyId: limitCompanyId, title: "Root", status: "todo" });
      await db.insert(issueRelations).values(ids.map((id) => ({
        companyId: limitCompanyId, issueId: limitRootId, relatedIssueId: id, type: "blocks",
      })));
      queries.length = 0;
      const withEdges = await loadBlockedGraph(observedDb, limitCompanyId);
      expect(withEdges.edges.map((edge) => edge.blockedId)).toEqual(ids.slice(0, BLOCKED_GRAPH_QUERY_LIMIT));
      expect(withEdges.blockedIssues).toEqual(withoutEdges.blockedIssues);
      expect(withEdges.truncated).toEqual({ edges: true, blockedIssues: true });
      expect(queries).toHaveLength(2);
      expect(queries.filter((query) => /from\s+"?issue_relations"?/i.test(query))).toHaveLength(1);
    } finally {
      await observedDb.$client.end();
    }
  });
});