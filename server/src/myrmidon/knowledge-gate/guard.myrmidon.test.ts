import { afterEach, describe, expect, it, vi } from "vitest";
import { behaviorSettingRegistry } from "@myrmidon/shared";
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
import {
  applyLiveBehaviorSettings,
  liveBehaviorSettingsView,
} from "../behavior-settings/live.js";
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
  const previousLive = liveBehaviorSettingsView();
  const prevMode = process.env.MYRMIDON_KNOWLEDGE_GATE_MODE;
  const prevStartDate = process.env.MYRMIDON_KNOWLEDGE_GATE_START_DATE;

  afterEach(() => {
    applyLiveBehaviorSettings(previousLive);
    if (prevMode === undefined) delete process.env.MYRMIDON_KNOWLEDGE_GATE_MODE;
    else process.env.MYRMIDON_KNOWLEDGE_GATE_MODE = prevMode;
    if (prevStartDate === undefined) delete process.env.MYRMIDON_KNOWLEDGE_GATE_START_DATE;
    else process.env.MYRMIDON_KNOWLEDGE_GATE_START_DATE = prevStartDate;
  });

  it("registers knowledgeGateMode and knowledgeGateStartDate in behaviorSettingRegistry", () => {
    const modeDef = behaviorSettingRegistry.get("knowledgeGateMode");
    expect(modeDef).toMatchObject({
      key: "knowledgeGateMode",
      envName: "MYRMIDON_KNOWLEDGE_GATE_MODE",
      default: "auto",
      section: "system",
      scope: "instance",
      valueType: "string",
    });
    expect(modeDef?.validate("auto")).toBe("auto");
    expect(modeDef?.validate("warning")).toBe("warning");
    expect(modeDef?.validate("enforce")).toBe("enforce");
    expect(modeDef?.validate("invalid")).toBeNull();

    const dateDef = behaviorSettingRegistry.get("knowledgeGateStartDate");
    expect(dateDef).toMatchObject({
      key: "knowledgeGateStartDate",
      envName: "MYRMIDON_KNOWLEDGE_GATE_START_DATE",
      default: "2026-10-31T00:00:00.000Z",
      section: "system",
      scope: "instance",
      valueType: "string",
    });
    expect(dateDef?.validate("2026-12-01T00:00:00.000Z")).toBe("2026-12-01T00:00:00.000Z");
    expect(dateDef?.validate("not-a-date")).toBeNull();
  });

  it("returns warning during the first 3 days", () => {
    delete process.env.MYRMIDON_KNOWLEDGE_GATE_MODE;
    delete process.env.MYRMIDON_KNOWLEDGE_GATE_START_DATE;
    applyLiveBehaviorSettings({ settings: {}, sources: {} });
    expect(getKnowledgeGateMode(new Date("2026-11-01T00:00:00Z"))).toBe("warning");
    expect(getKnowledgeGateMode(new Date("2026-11-02T23:59:59Z"))).toBe("warning");
  });

  it("returns enforce after 3 days", () => {
    delete process.env.MYRMIDON_KNOWLEDGE_GATE_MODE;
    delete process.env.MYRMIDON_KNOWLEDGE_GATE_START_DATE;
    applyLiveBehaviorSettings({ settings: {}, sources: {} });
    expect(getKnowledgeGateMode(new Date("2026-11-04T00:00:01Z"))).toBe("enforce");
    expect(getKnowledgeGateMode(new Date("2027-01-01T00:00:00Z"))).toBe("enforce");
  });

  it("respects env overrides", () => {
    process.env.MYRMIDON_KNOWLEDGE_GATE_MODE = "warning";
    expect(getKnowledgeGateMode(new Date("2027-01-01T00:00:00Z"))).toBe("warning");
    process.env.MYRMIDON_KNOWLEDGE_GATE_MODE = "enforce";
    expect(getKnowledgeGateMode(new Date("2026-11-01T00:00:00Z"))).toBe("enforce");
  });

  it("applies saved UI mode without restart and enforces env precedence over saved", () => {
    const insideGrace = new Date("2026-11-01T00:00:00Z");
    const afterGrace = new Date("2027-01-01T00:00:00Z");

    delete process.env.MYRMIDON_KNOWLEDGE_GATE_MODE;
    delete process.env.MYRMIDON_KNOWLEDGE_GATE_START_DATE;

    // Saved UI `enforce` enables strict mode before grace period ends
    applyLiveBehaviorSettings({
      settings: { knowledgeGateMode: "enforce" },
      sources: { knowledgeGateMode: "ui" },
    });
    expect(getKnowledgeGateMode(insideGrace)).toBe("enforce");
    expect(getKnowledgeGateMode(afterGrace)).toBe("enforce");

    // Live switch to saved UI `warning` applies immediately without restart
    applyLiveBehaviorSettings({
      settings: { knowledgeGateMode: "warning" },
      sources: { knowledgeGateMode: "ui" },
    });
    expect(getKnowledgeGateMode(insideGrace)).toBe("warning");
    expect(getKnowledgeGateMode(afterGrace)).toBe("warning");

    // Explicit env `enforce` overrides saved `warning`
    process.env.MYRMIDON_KNOWLEDGE_GATE_MODE = "enforce";
    expect(getKnowledgeGateMode(insideGrace)).toBe("enforce");
    expect(getKnowledgeGateMode(afterGrace)).toBe("enforce");

    // Explicit env `warning` overrides saved `enforce`
    applyLiveBehaviorSettings({
      settings: { knowledgeGateMode: "enforce" },
      sources: { knowledgeGateMode: "ui" },
    });
    process.env.MYRMIDON_KNOWLEDGE_GATE_MODE = "warning";
    expect(getKnowledgeGateMode(afterGrace)).toBe("warning");

    // Saved `auto` follows the date-based rollout when env is unset
    delete process.env.MYRMIDON_KNOWLEDGE_GATE_MODE;
    applyLiveBehaviorSettings({
      settings: { knowledgeGateMode: "auto" },
      sources: { knowledgeGateMode: "ui" },
    });
    expect(getKnowledgeGateMode(insideGrace)).toBe("warning");
    expect(getKnowledgeGateMode(afterGrace)).toBe("enforce");
  });

  it("applies saved start date without restart and prioritizes env start date", () => {
    delete process.env.MYRMIDON_KNOWLEDGE_GATE_MODE;
    delete process.env.MYRMIDON_KNOWLEDGE_GATE_START_DATE;

    // Saved start date shifts rollout window without restart
    applyLiveBehaviorSettings({
      settings: { knowledgeGateMode: "auto", knowledgeGateStartDate: "2027-02-01T00:00:00.000Z" },
      sources: { knowledgeGateMode: "ui", knowledgeGateStartDate: "ui" },
    });
    expect(getKnowledgeGateMode(new Date("2027-02-02T00:00:00Z"))).toBe("warning");
    expect(getKnowledgeGateMode(new Date("2027-02-05T00:00:00Z"))).toBe("enforce");

    // Explicit env start date overrides saved start date
    process.env.MYRMIDON_KNOWLEDGE_GATE_START_DATE = "2027-03-10T00:00:00.000Z";
    expect(getKnowledgeGateMode(new Date("2027-03-11T00:00:00Z"))).toBe("warning");
    expect(getKnowledgeGateMode(new Date("2027-02-02T00:00:00Z"))).toBe("warning");
    expect(getKnowledgeGateMode(new Date("2027-03-14T00:00:00Z"))).toBe("enforce");
  });

  it("falls back to constant when env or saved start date is unreadable", () => {
    delete process.env.MYRMIDON_KNOWLEDGE_GATE_MODE;
    const insideDefaultGrace = new Date("2026-11-01T00:00:00Z");
    const afterDefaultGrace = new Date("2026-11-05T00:00:00Z");

    // Garbage saved start date -> falls back to KNOWLEDGE_GATE_START_DATE
    delete process.env.MYRMIDON_KNOWLEDGE_GATE_START_DATE;
    applyLiveBehaviorSettings({
      settings: { knowledgeGateStartDate: "not-a-valid-date" },
      sources: { knowledgeGateStartDate: "ui" },
    });
    expect(getKnowledgeGateMode(insideDefaultGrace)).toBe("warning");
    expect(getKnowledgeGateMode(afterDefaultGrace)).toBe("enforce");

    // Garbage env start date -> falls back to saved if valid, else constant
    process.env.MYRMIDON_KNOWLEDGE_GATE_START_DATE = "garbage-date";
    applyLiveBehaviorSettings({ settings: {}, sources: {} });
    expect(getKnowledgeGateMode(insideDefaultGrace)).toBe("warning");
    expect(getKnowledgeGateMode(afterDefaultGrace)).toBe("enforce");

    // Garbage env start date + valid saved start date -> uses saved start date
    applyLiveBehaviorSettings({
      settings: { knowledgeGateStartDate: "2027-05-01T00:00:00.000Z" },
      sources: { knowledgeGateStartDate: "ui" },
    });
    expect(getKnowledgeGateMode(new Date("2027-05-02T00:00:00Z"))).toBe("warning");
    expect(getKnowledgeGateMode(new Date("2027-05-05T00:00:00Z"))).toBe("enforce");

    // Both garbage -> falls back to constant
    applyLiveBehaviorSettings({
      settings: { knowledgeGateStartDate: "also-garbage" },
      sources: { knowledgeGateStartDate: "ui" },
    });
    expect(getKnowledgeGateMode(insideDefaultGrace)).toBe("warning");
    expect(getKnowledgeGateMode(afterDefaultGrace)).toBe("enforce");
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
