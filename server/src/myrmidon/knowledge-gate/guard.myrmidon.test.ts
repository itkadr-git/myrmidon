import { describe, expect, it, vi } from "vitest";
import {
  issueLabels as issueLabelsTable,
  labels as labelsTable,
  issueComments as commentsTable,
  issueWorkProducts as workProductsTable,
  knowledgeItems as knowledgeItemsTable,
  knowledgeRevisions as knowledgeRevisionsTable,
} from "@myrmidon/db";
import {
  assertKnowledgeGateSettled,
  detectSystemAlteringChanges,
  getKnowledgeGateMode,
  isPathSystemAltering,
  isTextSystemAltering,
  KNOWLEDGE_NOTE_REQUIRED,
  parseWikiCommentLine,
  validateKnowledgeNoteRevisions,
} from "./guard.js";
import { HttpError } from "../../errors.js";

const issueId = "11111111-1111-1111-1111-111111111111";
const companyId = "22222222-2222-2222-2222-222222222222";

function fakeDb(tables: {
  issueLabels?: unknown[];
  issueWorkProducts?: unknown[];
  issueComments?: unknown[];
  knowledgeItems?: unknown[];
  knowledgeRevisions?: unknown[];
}) {
  // Routes each select to the table it queries. The guard queries tables in a
  // fixed set; a select is recognized by which table object was passed to it.
  const labelRows = tables.issueLabels ?? [];
  const productRows = tables.issueWorkProducts ?? [];
  const commentRows = tables.issueComments ?? [];
  const itemRows = tables.knowledgeItems ?? [];
  const revisionRows = tables.knowledgeRevisions ?? [];
  const select = vi.fn(() => {
    const from = vi.fn((table: unknown) => {
      const rows =
        table === issueLabelsTable || table === labelsTable
          ? labelRows
          : table === workProductsTable
            ? productRows
            : table === commentsTable
              ? commentRows
              : table === knowledgeItemsTable
                ? itemRows
                : table === knowledgeRevisionsTable
                  ? revisionRows
                  : [];
      const where = vi.fn(() => {
        const result = Promise.resolve(rows);
        return Object.assign(result, {
          limit: vi.fn(async () => rows),
        });
      });
      const chain = { where };
      return { ...chain, innerJoin: () => chain };
    });
    return { from };
  });
  return { select } as never;
}

describe("getKnowledgeGateMode", () => {
  it("returns warning during the first 3 days", () => {
    expect(getKnowledgeGateMode(new Date("2026-11-01T00:00:00Z"))).toBe("warning");
    expect(getKnowledgeGateMode(new Date("2026-11-02T23:59:59Z"))).toBe("warning");
  });

  it("returns enforce after 3 days", () => {
    expect(getKnowledgeGateMode(new Date("2026-11-04T00:00:01Z"))).toBe("enforce");
    expect(getKnowledgeGateMode(new Date("2027-01-01T00:00:00Z"))).toBe("enforce");
  });

  it("respects env overrides", () => {
    const prev = process.env.MYRMIDON_KNOWLEDGE_GATE_MODE;
    try {
      process.env.MYRMIDON_KNOWLEDGE_GATE_MODE = "warning";
      expect(getKnowledgeGateMode(new Date("2027-01-01T00:00:00Z"))).toBe("warning");
      process.env.MYRMIDON_KNOWLEDGE_GATE_MODE = "enforce";
      expect(getKnowledgeGateMode(new Date("2026-11-01T00:00:00Z"))).toBe("enforce");
    } finally {
      if (prev === undefined) delete process.env.MYRMIDON_KNOWLEDGE_GATE_MODE;
      else process.env.MYRMIDON_KNOWLEDGE_GATE_MODE = prev;
    }
  });
});

describe("isPathSystemAltering", () => {
  it("detects docker paths", () => {
    expect(isPathSystemAltering("docker/Dockerfile")).toBe(true);
    expect(isPathSystemAltering("docker/compose/web.yml")).toBe(true);
    expect(isPathSystemAltering("packages/app/src/x.ts")).toBe(false);
  });

  it("detects deploy paths", () => {
    expect(isPathSystemAltering("deploy/production.yml")).toBe(true);
    expect(isPathSystemAltering("scripts/myrmidon/deploy/rollout.sh")).toBe(true);
  });

  it("detects compose anywhere", () => {
    expect(isPathSystemAltering("ops/docker-compose.yml")).toBe(true);
    expect(isPathSystemAltering("compose/stack.yaml")).toBe(true);
  });

  it("detects db migrations", () => {
    expect(isPathSystemAltering("packages/db/src/migrations/0001_init.sql")).toBe(true);
    expect(isPathSystemAltering("packages/db/migrations/0002.sql")).toBe(true);
  });

  it("detects myrmidon routes files", () => {
    expect(isPathSystemAltering("server/src/myrmidon/issues-routes.ts")).toBe(true);
    expect(isPathSystemAltering("server/src/myrmidon/foo/bar-routes.ts")).toBe(true);
    expect(isPathSystemAltering("server/src/myrmidon/other.ts")).toBe(false);
  });
});

describe("isTextSystemAltering", () => {
  it("detects compose and ports keywords", () => {
    expect(isTextSystemAltering("added docker-compose for prod")).toBe(true);
    expect(isTextSystemAltering("поменяли порты на 5432")).toBe(true);
    expect(isTextSystemAltering("fix typo in docs")).toBe(false);
  });

  it("detects deploy paths in text", () => {
    expect(isTextSystemAltering("updated deploy/manifest.yml")).toBe(true);
    expect(isTextSystemAltering("touch packages/db/src/migrations/0010_x.sql")).toBe(true);
  });
});

describe("parseWikiCommentLine", () => {
  it("finds no line when absent", () => {
    expect(parseWikiCommentLine("сделано, всё ок").found).toBe(false);
  });

  it("parses slug@rev references", () => {
    const parsed = parseWikiCommentLine("Вики: infra/deploy@3");
    expect(parsed.found).toBe(true);
    expect(parsed.isNoChangesClaim).toBeFalsy();
    expect(parsed.references).toEqual([{ slug: "infra/deploy", rev: "3" }]);
  });

  it("parses multiple references", () => {
    const parsed = parseWikiCommentLine("Wiki: ops/runbook@12, arch/ports@1");
    expect(parsed.references).toHaveLength(2);
    expect(parsed.references[0]).toEqual({ slug: "ops/runbook", rev: "12" });
    expect(parsed.references[1]).toEqual({ slug: "arch/ports", rev: "1" });
  });

  it("accepts the no-changes claim", () => {
    const parsed = parseWikiCommentLine("Вики: устройство не менялось");
    expect(parsed.found).toBe(true);
    expect(parsed.isNoChangesClaim).toBe(true);
  });

  it("ignores the marker in mid-line", () => {
    expect(parseWikiCommentLine("см. Вики: что-то").found).toBe(false);
  });
});

describe("validateKnowledgeNoteRevisions", () => {
  it("reports missing items and revisions", async () => {
    const db = fakeDb({
      knowledgeItems: [],
    });
    const result = await validateKnowledgeNoteRevisions(db, companyId, [
      { slug: "infra/deploy", rev: "3" },
    ]);
    expect(result.valid).toBe(false);
    expect(result.missing[0].slug).toBe("infra/deploy");
  });
});

describe("assertKnowledgeGateSettled", () => {
  it("passes when changes are not system-altering", async () => {
    const db = fakeDb({ issueLabels: [] });
    const result = await assertKnowledgeGateSettled(db, {
      companyId,
      issueId,
      comment: "готово",
      now: new Date("2026-11-10T00:00:00Z"),
    });
    expect(result.passed).toBe(true);
    expect(result.isSystemAltering).toBe(false);
  });

  it("warns during grace period without wiki line", async () => {
    const db = fakeDb({
      issueLabels: [{ name: "infra" }],
      issueComments: [],
    });
    const result = await assertKnowledgeGateSettled(db, {
      companyId,
      issueId,
      comment: "задача закрыта",
      now: new Date("2026-11-01T00:00:00Z"),
    });
    expect(result.passed).toBe(true);
    expect(result.warning).toBe(true);
  });

  it("throws 422 knowledge_note_required after grace period without wiki line", async () => {
    const db = fakeDb({
      issueLabels: [{ name: "infra" }],
      issueComments: [],
    });
    await expect(
      assertKnowledgeGateSettled(db, {
        companyId,
        issueId,
        comment: "задача закрыта",
        now: new Date("2026-11-10T00:00:00Z"),
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: KNOWLEDGE_NOTE_REQUIRED },
    });
  });

  it("passes when a valid wiki reference resolves", async () => {
    const db = fakeDb({
      issueLabels: [{ name: "infra" }],
      knowledgeItems: [{ id: "item-1", slug: "infra/deploy" }],
      knowledgeRevisions: [{ id: "rev-1" }],
    });
    const result = await assertKnowledgeGateSettled(db, {
      companyId,
      issueId,
      comment: "Вики: infra/deploy@3",
      now: new Date("2026-11-10T00:00:00Z"),
    });
    expect(result.passed).toBe(true);
    expect(result.warning).toBeFalsy();
  });

  it("throws when the referenced revision does not exist", async () => {
    const db = fakeDb({
      issueLabels: [{ name: "architecture" }],
      knowledgeItems: [{ id: "item-1", slug: "infra/deploy" }],
      knowledgeRevisions: [],
    });
    await expect(
      assertKnowledgeGateSettled(db, {
        companyId,
        issueId,
        comment: "Вики: infra/deploy@9",
        now: new Date("2026-11-10T00:00:00Z"),
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: KNOWLEDGE_NOTE_REQUIRED },
    });
  });

  it("reads the wiki line from prior issue comments", async () => {
    const db = fakeDb({
      issueLabels: [{ name: "infra" }],
      issueComments: [{ body: "Вики: infra/deploy@3" }],
      knowledgeItems: [{ id: "item-1", slug: "infra/deploy" }],
      knowledgeRevisions: [{ id: "rev-1" }],
    });
    const result = await assertKnowledgeGateSettled(db, {
      companyId,
      issueId,
      comment: null,
      now: new Date("2026-11-10T00:00:00Z"),
    });
    expect(result.passed).toBe(true);
  });
});
