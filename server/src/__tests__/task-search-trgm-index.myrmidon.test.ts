// myrmidon(PERF-DIET-P): guard for the text-search index coverage.
//
// Company and task search match task text through ILIKE over pg_trgm GIN
// indexes. The task-search statement (server/src/services/task-search.ts) matches
// the columns bare — issues(title), issues(description), issue_comments(body),
// documents(title), documents(latest_body) — and those indexes exist since the
// vendor migrations 0051 and 0079. Company search has a second family of
// predicates that wrap the column in coalesce
// (server/src/services/company-search.ts, company-artifacts.ts):
//
//   coalesce(documents.title, '')      ILIKE '%…%'
//   coalesce(issues.identifier, '')    ILIKE '%…%'
//
// A wrapped expression cannot use the plain-column index, so the planner falls
// back to a sequential scan of documents (the table that carries the heavy
// latest_body column) and of issues. Migration
// 0314_search_coalesce_trgm_indexes.sql adds one expression index per emitted
// shape. This suite proves the coverage, and fails if a later change drops an
// index or changes the emitted expression away from the indexed one:
//
//   - every search index exists and is a GIN index;
//   - every emitted predicate is servable by its index (Bitmap Index Scan, no
//     sequential scan of the searched table);
//   - dropping the expression index takes that away, so the assertions have
//     teeth;
//   - the real company-search service returns the same hits with and without
//     the expression indexes (no semantics change);
//   - re-applying the migration statements is a no-op.
//
// Where the planner's choice at this corpus size also depends on the trigram
// selectivity estimate of the searched column, the case is asserted with
// `enable_seqscan = off`: the property the migration adds is that the index
// *can* serve the emitted expression, and the red side below shows what happens
// without it. A predicate written as an OR over two columns is deliberately not
// asserted as a whole — the cost model prefers a sequential scan for the
// disjunction at this corpus size even when both of its terms are servable,
// which is a fact about corpus size rather than about index coverage, so each
// term is asserted on its own.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { companySearchQuerySchema } from "@paperclipai/shared";
import { companySearchService } from "../services/company-search.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

/** Rows per seeded table: large enough that a sequential scan loses to the index. */
const ISSUE_ROWS = 50_000;
const DOCUMENT_ROWS = 20_000;

const SEARCH_INDEXES = [
  "issues_title_search_idx",
  "issues_description_search_idx",
  "issues_identifier_search_idx",
  "issues_coalesced_identifier_search_idx",
  "issue_comments_body_search_idx",
  "documents_title_search_idx",
  "documents_latest_body_search_idx",
  "documents_coalesced_title_search_idx",
];

const EXPRESSION_INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS "documents_coalesced_title_search_idx" ON "documents" USING gin ((coalesce("title", '')) gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS "issues_coalesced_identifier_search_idx" ON "issues" USING gin ((coalesce("identifier", '')) gin_trgm_ops)`,
];

let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let companyId = "";
let artifactDocumentId = "";

function planText(rows: Array<Record<string, unknown>>): string {
  return rows.map((row) => String(Object.values(row)[0])).join("\n");
}

async function explain(query: string, options: { sequentialScan?: "on" | "off" } = {}): Promise<string> {
  if (options.sequentialScan) {
    await db.execute(sql.raw(`SET enable_seqscan = ${options.sequentialScan}`));
  }
  try {
    const rows = await db.execute(sql.raw(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${query}`));
    return planText(rows as Array<Record<string, unknown>>);
  } finally {
    if (options.sequentialScan) await db.execute(sql.raw("SET enable_seqscan = on"));
  }
}

function usesIndex(plan: string, index: string): boolean {
  return plan.includes(`Index Scan on ${index}`) || plan.includes(`Index Only Scan on ${index}`);
}

/** The predicate, as the service emits it, for the operator's own term. */
function documentsPredicate(term: string): string {
  return `SELECT id FROM documents WHERE company_id = '${companyId}'
    AND (coalesce(title, '') ILIKE '%${term}%' ESCAPE '\\' OR latest_body ILIKE '%${term}%' ESCAPE '\\')`;
}

d("text search index coverage", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-search-index-");
    db = createDb(tempDb.connectionString, { maxConnections: 1, idleTimeoutSeconds: 0 });
    companyId = randomUUID();
    artifactDocumentId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix, require_board_approval_for_new_agents, default_responsible_user_id)
      VALUES (${companyId}, 'Search index guard', 'IDX', false, 'responsible-user')`);
    await db.execute(sql`INSERT INTO agents (id, company_id, name, role, status, adapter_type, adapter_config, runtime_config, permissions)
      VALUES (${agentId}, ${companyId}, 'Guard agent', 'engineer', 'active', 'codex_local', '{}'::jsonb,
              '{"heartbeat":{"wakeOnDemand":true,"maxConcurrentRuns":1}}'::jsonb, '{}'::jsonb)`);
    // Corpus: every row carries the same filler, a small slice carries the probe
    // term, so the term is selective and the planner can prefer the index.
    await db.execute(sql`
      INSERT INTO issues (company_id, title, description, identifier, status)
      SELECT ${companyId},
             CASE WHEN n % 200 = 2 THEN 'Zumbulator rollout task ' || n ELSE 'Quarterly handbook section ' || n END,
             CASE WHEN n % 200 = 3 THEN repeat('Investigate the kwibbles gateway fallback for the review cycle. ', 4)
                  ELSE repeat('Internal process notes for the review cycle and staffing tables. ', 4) END,
             CASE WHEN n % 50 = 0 THEN 'IDX-VROONIX-' || n ELSE 'IDX-' || n END, 'todo'
      FROM generate_series(1, ${ISSUE_ROWS}) n`);
    await db.execute(sql`
      INSERT INTO issue_comments (company_id, issue_id, body)
      SELECT ${companyId}, id, repeat('Internal progress note: verified the pipeline output. ', 4)
      FROM issues WHERE company_id = ${companyId}`);
    await db.execute(sql`
      INSERT INTO issue_comments (company_id, issue_id, body)
      SELECT ${companyId}, id, 'Blocked on the zumbulator handshake.'
      FROM issues WHERE company_id = ${companyId} AND identifier LIKE 'IDX-VROONIX-1%'`);
    await db.execute(sql`
      INSERT INTO documents (id, company_id, title, latest_body, format, created_by_agent_id)
      SELECT gen_random_uuid(), ${companyId},
             CASE WHEN n % 200 = 0 THEN 'Zumbulator rollout doc ' || n
                  WHEN n % 200 = 1 THEN 'Kwibbles gateway doc ' || n
                  ELSE 'Handbook section ' || n END,
             CASE WHEN n % 200 = 1 THEN repeat('Internal notes with the kwibbles gateway fallback. ', 8)
                  ELSE repeat('Internal process notes for the review cycle. ', 8) END,
             'markdown', ${agentId}
      FROM generate_series(1, ${DOCUMENT_ROWS}) n`);
    // One artifact document on its own unique term, reachable through company search.
    await db.execute(sql`
      INSERT INTO documents (id, company_id, title, latest_body, format, created_by_agent_id)
      VALUES (${artifactDocumentId}, ${companyId}, 'Qwerty access charter', 'Charter body.', 'markdown', ${agentId})`);
    await db.execute(sql`
      INSERT INTO issues (id, company_id, title, identifier, status)
      VALUES (${issueId}, ${companyId}, 'Charter task', 'IDX-CHARTER', 'todo')`);
    await db.execute(sql`
      INSERT INTO issue_documents (company_id, issue_id, document_id, key)
      VALUES (${companyId}, ${issueId}, ${artifactDocumentId}, 'artifact-notes')`);
    for (const table of ["issues", "issue_comments", "documents"]) {
      await db.execute(sql.raw(`ANALYZE ${table}`));
    }
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("has every search index as a GIN index on the expected expression", async () => {
    const extension = await db.execute(sql`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`);
    expect(extension).toHaveLength(1);
    const rows = (await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE indexname IN ${sql.raw(`(${SEARCH_INDEXES.map((name) => `'${name}'`).join(", ")})`)}`)) as unknown as Array<{
      indexname: string;
      indexdef: string;
    }>;
    expect(rows.map((row) => row.indexname).sort()).toEqual([...SEARCH_INDEXES].sort());
    for (const row of rows) expect(row.indexdef).toMatch(/ USING gin /);
    const expression = rows.find((row) => row.indexname === "documents_coalesced_title_search_idx")!;
    expect(expression.indexdef).toMatch(/COALESCE\(title, ''::text\) gin_trgm_ops/);
  }, 90_000);

  it("serves every emitted search predicate with its index", async () => {
    const cases: Array<{ label: string; query: string; index: string; sequentialScan?: "off" }> = [
      {
        label: "coalesce(documents.title)",
        query: documentsPredicate("zumbulator"),
        index: "documents_coalesced_title_search_idx",
      },
      {
        label: "documents.latest_body",
        query: `SELECT id FROM documents WHERE company_id = '${companyId}' AND latest_body ILIKE '%kwibbles%'`,
        index: "documents_latest_body_search_idx",
        sequentialScan: "off",
      },
      {
        label: "coalesce(issues.identifier)",
        query: `SELECT id FROM issues WHERE company_id = '${companyId}' AND coalesce(identifier, '') ILIKE '%vroonix%' ESCAPE '\\'`,
        index: "issues_coalesced_identifier_search_idx",
      },
      {
        label: "issues.title",
        query: `SELECT id FROM issues WHERE company_id = '${companyId}' AND title ILIKE '%zumbulator%'`,
        index: "issues_title_search_idx",
      },
      {
        label: "issues.description",
        query: `SELECT id FROM issues WHERE company_id = '${companyId}' AND description ILIKE '%kwibbles%'`,
        index: "issues_description_search_idx",
        sequentialScan: "off",
      },
      {
        label: "issue_comments.body",
        query: `SELECT issue_id FROM issue_comments WHERE company_id = '${companyId}' AND deleted_at IS NULL AND body ILIKE '%zumbulator%' GROUP BY issue_id`,
        index: "issue_comments_body_search_idx",
      },
    ];
    const failures: string[] = [];
    for (const testCase of cases) {
      const plan = await explain(testCase.query, { sequentialScan: testCase.sequentialScan });
      if (!usesIndex(plan, testCase.index)) {
        failures.push(`${testCase.label} → expected ${testCase.index}\n${plan}`);
      }
    }
    expect(failures.join("\n\n")).toBe("");
  }, 120_000);

  it("falls back to a sequential scan when the expression index is dropped", async () => {
    const before = await explain(documentsPredicate("zumbulator"));
    expect(usesIndex(before, "documents_coalesced_title_search_idx"), before).toBe(true);
    await db.execute(sql.raw(`DROP INDEX documents_coalesced_title_search_idx`));
    await db.execute(sql.raw("ANALYZE documents"));
    const after = await explain(documentsPredicate("zumbulator"));
    expect(usesIndex(after, "documents_coalesced_title_search_idx"), after).toBe(false);
    expect(after).toContain("Seq Scan on documents");
    await db.execute(sql.raw(EXPRESSION_INDEX_STATEMENTS[0]!));
    await db.execute(sql.raw("ANALYZE documents"));
    const restored = await explain(documentsPredicate("zumbulator"));
    expect(usesIndex(restored, "documents_coalesced_title_search_idx"), restored).toBe(true);
  }, 90_000);

  it("keeps company search results identical with and without the expression indexes", async () => {
    const query = companySearchQuerySchema.parse({ q: "qwerty", scope: "all", limit: 25 });
    const withIndexes = await companySearchService(db).search(companyId, query);
    const artifactHits = withIndexes.results.filter((row) => row.type === "artifact");
    expect(artifactHits.length, JSON.stringify(withIndexes.results)).toBeGreaterThan(0);
    expect(JSON.stringify(artifactHits)).toContain(artifactDocumentId);
    expect(withIndexes.countsByType.artifact).toBe(artifactHits.length);
    await db.execute(sql.raw(`DROP INDEX documents_coalesced_title_search_idx`));
    await db.execute(sql.raw(`DROP INDEX issues_coalesced_identifier_search_idx`));
    const withoutIndexes = await companySearchService(db).search(companyId, query);
    expect(withoutIndexes.results.map((row) => row.id).sort()).toEqual(withIndexes.results.map((row) => row.id).sort());
    expect(withoutIndexes.countsByType).toEqual(withIndexes.countsByType);
    for (const statement of EXPRESSION_INDEX_STATEMENTS) {
      await db.execute(sql.raw(statement));
    }
  }, 120_000);

  it("re-applies the migration statements without error", async () => {
    for (const statement of EXPRESSION_INDEX_STATEMENTS) {
      await db.execute(sql.raw(statement));
    }
    const rows = await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE indexname = 'issues_coalesced_identifier_search_idx'`);
    expect(rows).toHaveLength(1);
  }, 90_000);

  // Regression guard for a defect that shipped once: the migration file was
  // rebuilt by splitting text on the word CREATE INDEX, which also appears in
  // the header prose, so the first statement ended up glued onto a comment line
  // and became a comment. The statement count still looked right in a diff and
  // the oracle silently created one index instead of two.
  it("ships every migration statement uncommented and at column 0", () => {
    const file = readFileSync(
      new URL("../../../packages/db/src/migrations/0314_search_coalesce_trgm_indexes.sql", import.meta.url),
      "utf8",
    );
    const lines = file.split("\n");
    const statements = lines.filter((line) => !line.startsWith("--") && line.trim() !== "");
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('CREATE EXTENSION IF NOT EXISTS "pg_trgm"');
    expect(statements[1]).toContain('CREATE INDEX IF NOT EXISTS "documents_coalesced_title_search_idx"');
    expect(statements[2]).toContain('CREATE INDEX IF NOT EXISTS "issues_coalesced_identifier_search_idx"');
    for (const line of lines) {
      expect(
        line.startsWith("--") && line.includes(';"'),
        `a statement is hidden inside a comment line: ${line.slice(0, 90)}`,
      ).toBe(false);
    }
  });
});