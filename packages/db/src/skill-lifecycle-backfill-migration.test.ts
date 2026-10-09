import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// myrmidon(1.6.6 KNOWLEDGE-2.0 K-7): the legacy backfill (§5.5). The migration
// must (1) move every skill that has no lifecycle row to `verified` at its own
// current revision with `reason: legacy-2026-10` and one history event, without
// touching rows a real promotion already wrote; (2) deliver unchanged — the
// verified pointer equals the skill's current_version_id, which is exactly what
// the unmanaged path delivered; (3) create a published `skill_card` knowledge
// item per skill, mirrored into `knowledge_search` with provenance and audit
// rows; and (4) be a no-op on replay.

const MIGRATION_FILE = "0310_skill_lifecycle_backfill.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

async function unapplyMigration(sql: postgres.Sql) {
  await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
}

describeEmbeddedPostgres("skill lifecycle backfill migration", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("verifies legacy skills, builds skill cards, and is idempotent on replay", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-skill-backfill-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const legacySkillId = randomUUID();
    const legacyVersionId = randomUUID();
    const collisionFirstId = randomUUID();
    const collisionSecondId = randomUUID();
    const urlSkillId = randomUUID();
    const urlVersionId = randomUUID();
    const noVersionSkillId = randomUUID();
    const managedSkillId = randomUUID();
    const managedVersionId = randomUUID();
    const otherCompanySkillId = randomUUID();

    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES
        (${companyId}, 'Paperclip', 'PAP'),
        (${otherCompanyId}, 'Other', 'OTH')
    `;
    // company_skills.current_version_id -> company_skill_versions and back:
    // insert skills without the pointer first, then versions, then the pointer.
    await sql`
      INSERT INTO "company_skills" ("id", "company_id", "key", "slug", "name", "markdown", "description", "source_type", "source_locator", "categories")
      VALUES
        (${legacySkillId}, ${companyId}, 'paperclipai/bundled/DevOps/Deploy', 'deploy', 'Deploy', '# Deploy', 'Ship it to prod', 'catalog', 'git:ops/deploy', ARRAY['DevOps','Release']),
        (${collisionFirstId}, ${companyId}, 'company/foo-bar', 'foo-bar', 'Foo Bar', '# Foo', NULL, 'local_path', NULL, ARRAY[]),
        (${collisionSecondId}, ${companyId}, 'company/foo bar', 'foo-bar-2', 'Foo Bar Two', '# Foo2', 'second', 'local_path', '/srv/skills/foo', ARRAY[]),
        (${urlSkillId}, ${companyId}, 'company/url-skill', 'url-skill', 'URL Skill', '# URL', 'from the net', 'url', 'https://example.com/skill', ARRAY[]),
        (${noVersionSkillId}, ${companyId}, 'company/no-version', 'no-version', 'No Version', '# NV', '', 'local_path', '', ARRAY[]),
        (${managedSkillId}, ${companyId}, 'company/managed', 'managed', 'Managed', '# M', 'managed', 'catalog', 'git:managed', ARRAY[])
    `;
    await sql`
      INSERT INTO "company_skill_versions" ("id", "company_id", "company_skill_id", "revision_number")
      VALUES
        (${legacyVersionId}, ${companyId}, ${legacySkillId}, 3),
        (${urlVersionId}, ${companyId}, ${urlSkillId}, 1),
        (${managedVersionId}, ${companyId}, ${managedSkillId}, 7)
    `;
    await sql`
      UPDATE "company_skills" SET "current_version_id" = v."id"
      FROM "company_skill_versions" v
      WHERE v."company_skill_id" = "company_skills"."id"
    `;
    await sql`
      INSERT INTO "company_skills" ("id", "company_id", "key", "slug", "name", "markdown", "source_type", "categories")
      VALUES
        (${otherCompanySkillId}, ${otherCompanyId}, 'other/skill', 'skill', 'Other Skill', '# O', 'local_path', ARRAY[])
    `;
    // A lifecycle row a real promotion already wrote: the backfill must not
    // touch its state, pointer or reason.
    await sql`
      INSERT INTO "company_skill_lifecycle" ("company_id", "skill_id", "state", "verified_version_id", "reason", "approved_by")
      VALUES (${companyId}, ${managedSkillId}, 'verified', ${managedVersionId}, 'promoted via approval', 'user:alice')
    `;

    await applyPendingMigrations(database.connectionString);
    // The fixture rows were inserted after the boot-time migration run, so run
    // 0310 again to see the backfill act on them.
    await unapplyMigration(sql);
    await applyPendingMigrations(database.connectionString);

    const lifecycle = await sql<{
      skill_id: string;
      state: string;
      verified_version_id: string | null;
      reason: string | null;
      approved_by: string | null;
    }[]>`
      SELECT "skill_id", "state", "verified_version_id", "reason", "approved_by"
      FROM "company_skill_lifecycle"
      ORDER BY "skill_id"
    `;
    expect(lifecycle).toHaveLength(7); // every skill is now under the gates
    expect(lifecycle.find((row) => row.skill_id === legacySkillId)).toMatchObject({
      state: "verified",
      verified_version_id: legacyVersionId, // delivery stays on the skill's own current revision
      reason: "legacy-2026-10",
      approved_by: "system:skill-lifecycle-backfill",
    });
    expect(lifecycle.find((row) => row.skill_id === noVersionSkillId)).toMatchObject({
      state: "verified",
      verified_version_id: null,
      reason: "legacy-2026-10",
    });
    expect(lifecycle.find((row) => row.skill_id === otherCompanySkillId)).toMatchObject({
      state: "verified",
      reason: "legacy-2026-10",
    });
    // The managed row was left exactly as the promotion wrote it.
    expect(lifecycle.find((row) => row.skill_id === managedSkillId)).toMatchObject({
      state: "verified",
      verified_version_id: managedVersionId,
      reason: "promoted via approval",
      approved_by: "user:alice",
    });

    const events = await sql<{ skill_id: string; from_state: string | null; to_state: string; reason: string | null; actor_type: string }[]>`
      SELECT "skill_id", "from_state", "to_state", "reason", "actor_type"
      FROM "company_skill_lifecycle_events"
      ORDER BY "skill_id"
    `;
    expect(events).toHaveLength(6); // one per created row; the managed row has no backfill event
    expect(events.every((event) => event.to_state === "verified" && event.reason === "legacy-2026-10")).toBe(true);
    expect(events.every((event) => event.actor_type === "system")).toBe(true);

    const cards = await sql<{
      id: string;
      slug: string;
      kind: string;
      status: string;
      title: string;
      folder_path: string;
      tags: string[];
      delivered: string | null;
      revision_number: number;
    }[]>`
      SELECT k."id", k."slug", k."kind", k."status", k."title", k."folder_path", k."tags",
             k."delivered_revision_id" AS delivered, k."current_revision_number" AS revision_number
      FROM "knowledge_items" k
      WHERE k."kind" = 'skill_card'
      ORDER BY k."slug"
    `;
    expect(cards.map((card) => card.slug)).toEqual([
      "skills/company-foo-bar",
      "skills/company-foo-bar-2",
      "skills/company-managed",
      "skills/company-no-version",
      "skills/company-url-skill",
      "skills/other-skill",
      "skills/paperclipai-bundled-devops-deploy",
    ]);
    expect(cards.every((card) => card.status === "published" && card.delivered !== null && card.revision_number === 1)).toBe(true);
    expect(cards.every((card) => card.folder_path === "skills")).toBe(true);
    const deployCard = cards.find((card) => card.slug === "skills/paperclipai-bundled-devops-deploy")!;
    expect(deployCard.title).toBe("Deploy");
    expect(deployCard.tags).toEqual(["devops", "release"]);

    // The card content carries the description and the source line.
    const revision = await sql<{ content: string; status: string }[]>`
      SELECT "content", "status" FROM "knowledge_revisions"
      WHERE "item_id" = ${deployCard.id} AND "revision_number" = 1
    `;
    expect(revision[0]?.status).toBe("approved");
    expect(revision[0]?.content).toContain("Ship it to prod");
    expect(revision[0]?.content).toContain("- key: `paperclipai/bundled/DevOps/Deploy`");
    expect(revision[0]?.content).toContain("`catalog` — `git:ops/deploy`");

    // Search == delivery: every published card is in the read model.
    const searchRows = await sql<{ item_id: string }[]>`
      SELECT "item_id" FROM "knowledge_search"
      WHERE "item_id" IN (${sql.array(cards.map((card) => card.id))})
    `;
    expect(searchRows).toHaveLength(cards.length);

    // Provenance: skill sources mapped onto the knowledge taxonomy.
    const sources = await sql<{ kind: string; ref: string }[]>`
      SELECT s."kind", s."ref"
      FROM "knowledge_sources" s
      JOIN "knowledge_revisions" r ON r."id" = s."revision_id"
      JOIN "knowledge_items" k ON k."id" = r."item_id"
      WHERE k."slug" IN ('skills/company-url-skill', 'skills/paperclipai-bundled-devops-deploy')
      ORDER BY s."kind", s."ref"
    `;
    expect(sources).toEqual([
      { kind: "document", ref: "git:ops/deploy" },
      { kind: "url", ref: "https://example.com/skill" },
    ]);

    const auditEvents = await sql<{ item_id: string; event: string }[]>`
      SELECT "item_id", "event" FROM "knowledge_events"
      WHERE "event" = 'knowledge.backfilled'
    `;
    expect(auditEvents).toHaveLength(cards.length);

    // Replay: unapply and re-run — the guards make it a no-op.
    await unapplyMigration(sql);
    await applyPendingMigrations(database.connectionString);
    const afterReplay = await sql<{
      lifecycle_count: string;
      event_count: string;
      card_count: string;
      search_count: string;
      backfilled_count: string;
    }[]>`
      SELECT
        (SELECT COUNT(*) FROM "company_skill_lifecycle")::text AS lifecycle_count,
        (SELECT COUNT(*) FROM "company_skill_lifecycle_events")::text AS event_count,
        (SELECT COUNT(*) FROM "knowledge_items" WHERE "kind" = 'skill_card')::text AS card_count,
        (SELECT COUNT(*) FROM "knowledge_search" ks JOIN "knowledge_items" k ON k."id" = ks."item_id" WHERE k."kind" = 'skill_card')::text AS search_count,
        (SELECT COUNT(*) FROM "knowledge_events" WHERE "event" = 'knowledge.backfilled')::text AS backfilled_count
    `;
    expect(afterReplay[0]).toMatchObject({
      lifecycle_count: "7",
      event_count: "6",
      card_count: "7",
      search_count: "7",
      backfilled_count: "7",
    });
  }, 60_000);
});
