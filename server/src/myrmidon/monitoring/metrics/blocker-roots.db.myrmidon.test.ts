import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueRelations, issues, type Db } from "@myrmidon/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { collectBlockerRootMetrics, renderBlockerRootMetrics } from "./blocker-roots.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported && process.env.CI) throw new Error(`Postgres acceptance must run: ${support.reason}`);
(support.supported ? describe : describe.skip)("blocker root metrics (Postgres)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const rootId = randomUUID();
  const secondRootId = randomUUID();
  const dependents = Array.from({ length: 20 }, () => randomUUID());

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("blocker-root-metrics-");
    db = createDb(database.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Root metrics", issuePrefix: "ROOT" },
      { id: otherCompanyId, name: "Other root metrics", issuePrefix: "OTHER" },
    ]);
    await db.insert(issues).values([
      { id: rootId, companyId, title: "Terminal operator blocker", status: "todo" },
      { id: secondRootId, companyId: otherCompanyId, title: "Other root", status: "todo" },
      ...dependents.map((id) => ({ id, companyId, title: "Held task", status: "blocked" })),
    ]);
    await db.insert(issueRelations).values(dependents.map((id) => ({
      companyId, issueId: rootId, relatedIssueId: id, type: "blocks" as const,
    })));
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  }, 60_000);

  it("reports the OPE-8079 shape as fanout twenty and one terminal root", async () => {
    const sample = await collectBlockerRootMetrics(db);
    expect(sample.companies.find((row) => row.companyId === companyId)).toEqual({
      companyId, roots: [{ root: rootId, fanout: 20 }], terminalCount: 1, rootsOverLimit: 1,
    });
    expect(sample.companies.find((row) => row.companyId === otherCompanyId)).toEqual({
      companyId: otherCompanyId, roots: [], terminalCount: 0, rootsOverLimit: 0,
    });
    const text = renderBlockerRootMetrics(sample);
    expect(text).toContain(`blocker_root_fanout{company="${companyId}",root="${rootId}"} 20`);
    expect(text).toContain(`blocker_terminal_count{company="${companyId}"} 1`);
    expect(text).toContain(`blocker_roots_over_limit{company="${companyId}"} 1`);
  });

  it("bounds root labels without truncating aggregate counts and uses a strict limit", async () => {
    const sample = await collectBlockerRootMetrics(db, { topN: 0, fanoutLimit: 20 });
    expect(sample.companies.find((row) => row.companyId === companyId)).toEqual({
      companyId, roots: [], terminalCount: 1, rootsOverLimit: 0,
    });
  });
});
