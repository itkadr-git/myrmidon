// server/src/myrmidon/model-group-rules/store.db.myrmidon.test.ts
//
// myrmidon(1.8 MODEL-BY-STEP, OPE-12997): database-level isolation tests for
// createModelGroupRulesStore against real Postgres migrations.
//
// Acceptance criteria:
// КОГДА владелец сохраняет допустимое правило ТОГДА оно возвращается из API для
// компании и может быть переопределено кастой без влияния на другие компании.
//
// Verifies:
// 1. replaceAll & list are strictly scoped by companyId (Company A's rules
//    never leak to or overwrite Company B's rules).
// 2. Overwriting or clearing Company A's rules does not delete or alter Company B's rules.
// 3. existingCasteKeys only sees castes belonging to the queried company.
// 4. DB unique constraint (`company_model_group_rules_scope_step_uq` nullsNotDistinct)
//    prevents duplicate rules within the same scope (including casteKey = null).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentCastes, companies, companyModelGroupRules, createDb } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { createModelGroupRulesStore } from "./store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("myrmidon(1.8 MODEL-BY-STEP, OPE-12997) model-group-rules store DB isolation", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let store!: ReturnType<typeof createModelGroupRulesStore>;

  let companyAId!: string;
  let companyBId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-model-group-rules-store-");
    db = createDb(tempDb.connectionString);
    store = createModelGroupRulesStore(db);

    const [compA, compB] = await Promise.all([
      db
        .insert(companies)
        .values({ name: `company-a ${randomUUID()}`, issuePrefix: `MA${randomUUID().slice(0, 4).toUpperCase()}` })
        .returning()
        .then((rows) => rows[0]!),
      db
        .insert(companies)
        .values({ name: `company-b ${randomUUID()}`, issuePrefix: `MB${randomUUID().slice(0, 4).toUpperCase()}` })
        .returning()
        .then((rows) => rows[0]!),
    ]);
    companyAId = compA.id;
    companyBId = compB.id;

    await db.insert(agentCastes).values([
      { companyId: companyAId, key: "caste-a1", nameEn: "Caste A1" },
      { companyId: companyBId, key: "caste-b1", nameEn: "Caste B1" },
    ]);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("saves rules for company A and returns them isolated from company B", async () => {
    await store.replaceAll(companyAId, [
      { stepClass: "execution", modelGroup: "strong", casteKey: null },
      { stepClass: "review", modelGroup: "expert", casteKey: "caste-a1" },
    ]);

    await store.replaceAll(companyBId, [
      { stepClass: "execution", modelGroup: "economy", casteKey: null },
      { stepClass: "review", modelGroup: "fast", casteKey: "caste-b1" },
    ]);

    const rulesA = await store.list(companyAId);
    expect(rulesA).toHaveLength(2);
    expect(rulesA.find((r) => r.casteKey === null)?.modelGroup).toBe("strong");
    expect(rulesA.find((r) => r.casteKey === "caste-a1")?.modelGroup).toBe("expert");

    const rulesB = await store.list(companyBId);
    expect(rulesB).toHaveLength(2);
    expect(rulesB.find((r) => r.casteKey === null)?.modelGroup).toBe("economy");
    expect(rulesB.find((r) => r.casteKey === "caste-b1")?.modelGroup).toBe("fast");
  });

  it("modifying or clearing company A rules leaves company B rules completely intact", async () => {
    // Clear company A rules
    await store.replaceAll(companyAId, []);

    const rulesA = await store.list(companyAId);
    expect(rulesA).toHaveLength(0);

    // Company B rules are unchanged
    const rulesB = await store.list(companyBId);
    expect(rulesB).toHaveLength(2);
    expect(rulesB.find((r) => r.casteKey === null)?.modelGroup).toBe("economy");
    expect(rulesB.find((r) => r.casteKey === "caste-b1")?.modelGroup).toBe("fast");
  });

  it("validates caste existence strictly within company scope", async () => {
    // caste-a1 belongs to companyA, caste-b1 belongs to companyB
    const foundForA = await store.existingCasteKeys(companyAId, ["caste-a1", "caste-b1"]);
    expect(foundForA.has("caste-a1")).toBe(true);
    expect(foundForA.has("caste-b1")).toBe(false);

    const foundForB = await store.existingCasteKeys(companyBId, ["caste-a1", "caste-b1"]);
    expect(foundForB.has("caste-a1")).toBe(false);
    expect(foundForB.has("caste-b1")).toBe(true);
  });

  it("enforces database unique constraint on (companyId, casteKey, stepClass)", async () => {
    await store.replaceAll(companyAId, [
      { stepClass: "decomposition", modelGroup: "economy", casteKey: null },
    ]);

    // Direct insertion of a duplicate in the same scope (casteKey = null) must fail with unique violation
    await expect(
      db.insert(companyModelGroupRules).values({
        companyId: companyAId,
        stepClass: "decomposition",
        modelGroup: "strong",
        casteKey: null,
      }),
    ).rejects.toThrow();
  });
});
