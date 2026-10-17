// server/src/myrmidon/castes/castes-default-and-nests.db.myrmidon.test.ts
//
// myrmidon(1.6.5 F-26 T3 CASTES-AND-NESTS): the acceptance matrix of the part,
// on a real database:
//   - the seed flags exactly one default caste and a project-less task resolves
//     to it through port 1;
//   - moving the default radio changes the port's answer with NO restart;
//   - a task's own caste wins over the project default, the project default wins
//     over the company's, and the single-query fragment agrees with the port;
//   - deleting the default caste demands reassignTo and moves the agents and the
//     flag together;
//   - an agent nested in P1 is not eligible for a P2 task and is eligible for a
//     project-less task; an agent without nests is eligible everywhere.
//
// The pheromone columns (issues.caste_key, projects.default_caste_key) belong to
// F-27 T2 (OPE-6614) and merge BEFORE this part. Until that migration is in the
// tree the ALTERs in beforeAll create them for this test only; after T2 they are
// a no-op and the ports keep reading exactly these names.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agentCastes,
  agentNests as agentNestsTable,
  agents,
  companies,
  createDb,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { createCasteService } from "./service.js";
import { createAgentNestService } from "./nests-service.js";
import { createAgentNestStore } from "./nests-store.js";
import { agentNests, agentNestsAllowSql, resolveTaskCaste, taskCasteKeySql } from "./resolve.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

describeEmbeddedPostgres(
  "myrmidon(1.6.5 F-26 T3 CASTES-AND-NESTS) default caste and agent nests",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
    let companyId!: string;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-castes-t3-");
      db = createDb(tempDb.connectionString);
      await db.execute(sql`alter table issues add column if not exists caste_key text`);
      await db.execute(sql`alter table projects add column if not exists default_caste_key text`);
    }, 60_000);

    afterEach(async () => {
      await db.delete(agentNestsTable);
      await db.delete(issues);
      await db.delete(projects);
      await db.delete(agents);
      await db.delete(agentCastes);
      await db.delete(companies);
    });

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    const castes = () => createCasteService({ db });
    const nests = () => createAgentNestService({ db, store: createAgentNestStore({ db }) });

    async function makeCompany(): Promise<string> {
      const [row] = await db
        .insert(companies)
        .values({
          name: `company ${randomUUID()}`,
          issuePrefix: `T3${randomUUID().slice(0, 6).toUpperCase()}`,
        })
        .returning();
      return row!.id;
    }

    async function makeAgentIn(company: string, role: string): Promise<string> {
      const [row] = await db
        .insert(agents)
        .values({ companyId: company, name: `agent-${randomUUID().slice(0, 6)}`, role })
        .returning();
      return row!.id;
    }

    async function makeAgent(role: string): Promise<string> {
      return makeAgentIn(companyId, role);
    }

    async function makeProjectIn(company: string, name: string): Promise<string> {
      const [row] = await db.insert(projects).values({ companyId: company, name }).returning();
      return row!.id;
    }

    async function makeProject(name: string): Promise<string> {
      return makeProjectIn(companyId, name);
    }

    async function makeIssue(args: { projectId?: string; casteKey?: string } = {}): Promise<string> {
      const [row] = await db
        .insert(issues)
        .values({
          companyId,
          title: `task ${randomUUID().slice(0, 6)}`,
          status: "todo",
          projectId: args.projectId ?? null,
        })
        .returning();
      if (args.casteKey) {
        await db.execute(sql`update issues set caste_key = ${args.casteKey} where id = ${row!.id}`);
      }
      return row!.id;
    }

    /** The company's default caste key straight from the table. */
    async function defaultKey(): Promise<string | null> {
      const [row] = await db
        .select({ key: agentCastes.key })
        .from(agentCastes)
        .where(and(eq(agentCastes.companyId, companyId), eq(agentCastes.isDefault, true)));
      return row?.key ?? null;
    }

    /** The matcher's per-task question, asked through port 2's SQL fragment. */
    async function canTake(agentId: string, issueId: string): Promise<boolean> {
      const rows = await db.execute(sql`
        select 1 as ok from issues i
        where i.id = ${issueId}
          and ${agentNestsAllowSql({ agentId: sql`${agentId}`, projectId: sql`i.project_id` })}
      `);
      return rowsOf(rows).length > 0;
    }

    it("seeds exactly one default caste and resolves a project-less task to it", async () => {
      companyId = await makeCompany();
      const directory = await castes().listCastes(companyId);
      const defaults = directory.filter((c) => c.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0]!.key).toBe("engineer");

      const task = await makeIssue();
      await expect(resolveTaskCaste(db, { companyId, issueId: task })).resolves.toBe("engineer");
    });

    it("moving the default radio changes the port's answer without a restart", async () => {
      companyId = await makeCompany();
      await castes().listCastes(companyId); // seed
      const task = await makeIssue();
      await expect(resolveTaskCaste(db, { companyId, issueId: task })).resolves.toBe("engineer");

      const moved = await castes().updateCaste({
        companyId,
        key: "qa",
        body: { isDefault: true },
      });
      expect(moved.isDefault).toBe(true);
      expect(await defaultKey()).toBe("qa");

      // The same db handle answers with the new caste: nothing is cached between
      // two matcher passes, so a settings change needs no restart.
      await expect(resolveTaskCaste(db, { companyId, issueId: task })).resolves.toBe("qa");

      // A company always keeps a default: clearing the radio on the default
      // itself is a 409, the owner names the next one instead.
      await expect(
        castes().updateCaste({ companyId, key: "qa", body: { isDefault: false } }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await defaultKey()).toBe("qa");
    });

    it("a task's caste beats the project default, the project default beats the company's, and the fragment agrees with the port", async () => {
      companyId = await makeCompany();
      await castes().listCastes(companyId);
      const projectId = await makeProject("Разработка инструментов");
      await db.execute(
        sql`update projects set default_caste_key = 'designer' where id = ${projectId}`,
      );

      const inherited = await makeIssue({ projectId });
      await expect(resolveTaskCaste(db, { companyId, issueId: inherited })).resolves.toBe(
        "designer",
      );

      const pinned = await makeIssue({ projectId, casteKey: "researcher" });
      await expect(resolveTaskCaste(db, { companyId, issueId: pinned })).resolves.toBe(
        "researcher",
      );

      // The one-query path T1 uses (roleQueueRows) must give the same key.
      const rows = rowsOf<{ k: string | null }>(
        await db.execute(sql`
          select ${taskCasteKeySql({
            issueCasteKey: sql`i.caste_key`,
            projectDefaultKey: sql`p.default_caste_key`,
            companyId,
          })} as k
          from issues i
          left join projects p on p.id = i.project_id
          where i.id = ${pinned}
        `),
      );
      expect(rows[0]?.k).toBe("researcher");

      const inheritedRows = rowsOf<{ k: string | null }>(
        await db.execute(sql`
          select ${taskCasteKeySql({
            issueCasteKey: sql`i.caste_key`,
            projectDefaultKey: sql`p.default_caste_key`,
            companyId,
          })} as k
          from issues i
          left join projects p on p.id = i.project_id
          where i.id = ${inherited}
        `),
      );
      expect(inheritedRows[0]?.k).toBe("designer");
    });

    it("deleting the default caste needs reassignTo and moves the agents and the flag together", async () => {
      companyId = await makeCompany();
      await castes().listCastes(companyId);
      const agentId = await makeAgent("engineer");
      const task = await makeIssue();

      await expect(castes().removeCaste({ companyId, key: "engineer" })).rejects.toMatchObject({
        status: 409,
      });
      expect(await defaultKey()).toBe("engineer");

      await castes().removeCaste({ companyId, key: "engineer", reassignTo: "qa" });

      const [agent] = await db
        .select({ role: agents.role })
        .from(agents)
        .where(eq(agents.id, agentId));
      expect(agent?.role).toBe("qa");
      expect(await defaultKey()).toBe("qa");
      await expect(resolveTaskCaste(db, { companyId, issueId: task })).resolves.toBe("qa");
      const directory = await castes().listCastes(companyId);
      expect(directory.some((c) => c.key === "engineer")).toBe(false);
      expect(directory.filter((c) => c.isDefault)).toHaveLength(1);
    });

    it("nests: an agent nested in P1 refuses a P2 task but takes a project-less one; an agent without nests takes everything", async () => {
      companyId = await makeCompany();
      const p1 = await makeProject("Магазин");
      const p2 = await makeProject("Разработка инструментов");
      const nested = await makeAgent("engineer");
      const free = await makeAgent("engineer");

      const saved = await nests().putNests({ companyId, agentId: nested, projectIds: [p1] });
      expect(saved.view.projectIds).toEqual([p1]);
      expect(saved.added).toEqual([p1]);

      await expect(agentNests(db, nested)).resolves.toEqual([p1]);
      await expect(agentNests(db, free)).resolves.toEqual([]);

      const taskP1 = await makeIssue({ projectId: p1 });
      const taskP2 = await makeIssue({ projectId: p2 });
      const taskNone = await makeIssue();

      await expect(canTake(nested, taskP1)).resolves.toBe(true);
      await expect(canTake(nested, taskP2)).resolves.toBe(false);
      await expect(canTake(nested, taskNone)).resolves.toBe(true);

      await expect(canTake(free, taskP1)).resolves.toBe(true);
      await expect(canTake(free, taskP2)).resolves.toBe(true);
      await expect(canTake(free, taskNone)).resolves.toBe(true);
    });

    it("nests: an unknown project is refused as a whole, and an empty PUT clears the nests", async () => {
      companyId = await makeCompany();
      const p1 = await makeProject("Магазин");
      const agentId = await makeAgent("engineer");
      await nests().putNests({ companyId, agentId, projectIds: [p1] });

      await expect(
        nests().putNests({ companyId, agentId, projectIds: [p1, randomUUID()] }),
      ).rejects.toMatchObject({ status: 400 });
      // The refused PUT wrote nothing: the old nest is intact.
      await expect(agentNests(db, agentId)).resolves.toEqual([p1]);

      const cleared = await nests().putNests({ companyId, agentId, projectIds: [] });
      expect(cleared.view.projectIds).toEqual([]);
      expect(cleared.removed).toEqual([p1]);
      await expect(agentNests(db, agentId)).resolves.toEqual([]);
      await expect(canTake(agentId, await makeIssue({ projectId: p1 }))).resolves.toBe(true);
    });

    it("nests: another company's agent is not a nest owner (404) and another company's project is unknown (400)", async () => {
      companyId = await makeCompany();
      const owned = companyId;
      const mine = await makeProjectIn(owned, "Магазин");
      const stranger = await makeAgentIn(owned, "engineer");

      const other = await makeCompany();
      const otherProject = await makeProjectIn(other, "Чужой проект");
      const otherAgent = await makeAgentIn(other, "engineer");

      // An agent of company A is not addressable through company B.
      await expect(
        nests().putNests({ companyId: other, agentId: stranger, projectIds: [] }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        nests().putNests({ companyId: other, agentId: stranger, projectIds: [mine] }),
      ).rejects.toMatchObject({ status: 404 });

      // B's agent cannot be nested in A's project, not even next to a valid one.
      await expect(
        nests().putNests({ companyId: other, agentId: otherAgent, projectIds: [otherProject, mine] }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(agentNests(db, otherAgent)).resolves.toEqual([]);
    });
  },
);