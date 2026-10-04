// myrmidon(1.7-GRD-MODES): the integration tests of the enforcement modes
// (OPE-4167) over a real database. The acceptance criteria of the ticket:
//
//   1. A caste's rule change acts on the NEXT answer of an agent of that
//      caste — the run-output hook resolves the mode fresh from
//      instance_settings on every call, so changing the stored document
//      between two evaluations changes the decision, no restart.
//   2. The default with no settings at all is flag-only.
//
// Plus: mask replaces the matched spans, block replaces the whole answer
// with the refusal, the settings storage round-trips through
// instance_settings.general.guardrailModes, and the resolve route answers
// the effective chain with its source.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  guardrailEvents,
  heartbeatRuns,
  instanceSettings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { guardrailsOnRunOutput } from "./run-output.js";
import { maskGuardrailSpans, resolveGuardrailModeForAgent } from "./modes.js";
import {
  readGuardrailModesSettings,
  writeGuardrailModesSettings,
} from "./modes-settings.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import {
  GUARDRAILS_MODE_FORCE_ENV,
  normalizeGuardrailModesSettings,
} from "@paperclipai/shared";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const ENV_ON = { MYRMIDON_GUARDRAILS_OUTPUT_ENABLED: "1" } as Record<string, string>;
const FIXED_NOW = () => new Date("2026-01-02T03:04:05.000Z");

// Neutral fixture: a github-token-shaped string assembled from parts so the
// secret scanner of the repo never sees a continuous token literal.
const TOKEN_PARTS = ["ghp_", "0123456789", "abcdefghij", "KLMNOPQRST"];
const secretText = () => `the key is ${TOKEN_PARTS.join("")} for deploy`;

describeEmbeddedPostgres("myrmidon(1.7-GRD-MODES): enforcement modes integration", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let engineerAgentId = "";
  let runId: string | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-grd-modes-");
    db = createDb(tempDb.connectionString);
    const company = await db
      .insert(companies)
      .values({ name: `grd modes ${randomUUID()}`, issuePrefix: `GM${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;
    const engineer = await db
      .insert(agents)
      .values({ companyId, name: `eng-${randomUUID().slice(0, 6)}`, adapterType: "claude_code", role: "engineer" })
      .returning()
      .then((rows) => rows[0]!);
    engineerAgentId = engineer.id;
  }, 60_000);

  afterEach(async () => {
    await db.delete(guardrailEvents);
    await db.delete(activityLog);
    if (runId) {
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      runId = null;
    }
    // Reset the stored modes between cases: the empty document is the
    // shipped state.
    await db
      .update(instanceSettings)
      .set({ general: {} })
      .where(eq(instanceSettings.singletonKey, "default"));
    delete process.env[GUARDRAILS_MODE_FORCE_ENV];
    await db.delete(instanceSettings).where(eq(instanceSettings.singletonKey, "default"));
  });

  afterAll(async () => {
    await db.delete(guardrailEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, engineerAgentId));
    await db.delete(agents).where(eq(agents.id, engineerAgentId));
    await db.delete(companies).where(eq(companies.id, companyId));
    await tempDb?.cleanup();
  });

  async function seedRun(): Promise<string> {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId: engineerAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { issueId: null },
      })
      .returning();
    runId = run.id;
    return run.id;
  }

  async function storeModes(raw: unknown): Promise<void> {
    await db
      .insert(instanceSettings)
      .values({ singletonKey: "default", general: {}, experimental: {} })
      .onConflictDoNothing({ target: [instanceSettings.singletonKey] });
    await db.execute(
      sql`update ${instanceSettings} set general = jsonb_set(coalesce(general, '{}'::jsonb), '{guardrailModes}', ${JSON.stringify(raw)}::jsonb, true) where singleton_key = 'default'`,
    );
  }

  it("default is flag-only: no settings at all, the answer text continues unchanged", async () => {
    const id = await seedRun();
    const text = secretText();
    const decision = await guardrailsOnRunOutput({
      db,
      companyId,
      runId: id,
      issueId: null,
      agentId: engineerAgentId,
      text,
      env: ENV_ON,
      now: FIXED_NOW,
    });
    expect(decision.mode).toBe("flag");
    expect(decision.source).toBe("default");
    expect(decision.text).toBe(text);
    expect(decision.hits).toBeGreaterThan(0);
    // Events recorded at the 1.6.1 severities (secret -> warn).
    const events = await db.select().from(guardrailEvents);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((row) => row.severity === "warn")).toBe(true);
  });

  it("ACCEPTANCE: a caste rule change acts on the next answer of that caste's agent", async () => {
    const id = await seedRun();
    const text = secretText();

    // First answer: the caste rule says mask.
    await storeModes({ castes: { engineer: { secret: "mask" } } });
    const masked = await guardrailsOnRunOutput({
      db,
      companyId,
      runId: id,
      issueId: null,
      agentId: engineerAgentId,
      text,
      env: ENV_ON,
      now: FIXED_NOW,
    });
    expect(masked.mode).toBe("mask");
    expect(masked.source).toBe("caste");
    expect(masked.caste).toBe("engineer");
    // The token shape is gone from the text the comment would carry.
    expect(masked.text).not.toContain(TOKEN_PARTS.join(""));
    expect(masked.text).toContain("[masked]");

    // Second answer after the operator switched the same caste rule to
    // block — same process, no restart, fresh read:
    await storeModes({ castes: { engineer: { secret: "block" } } });
    const blocked = await guardrailsOnRunOutput({
      db,
      companyId,
      runId: id,
      issueId: null,
      agentId: engineerAgentId,
      text,
      env: ENV_ON,
      now: FIXED_NOW,
    });
    expect(blocked.mode).toBe("block");
    expect(blocked.source).toBe("caste");
    expect(blocked.text).toContain("withheld");
    expect(blocked.text).not.toContain(TOKEN_PARTS.join(""));
    // Blocked events are journaled at error severity.
    const events = await db.select().from(guardrailEvents);
    expect(events.some((row) => row.severity === "error")).toBe(true);
  });

  it("agent override beats the caste rule; company applies to agents without overrides", async () => {
    const id = await seedRun();
    const text = secretText();
    await storeModes({
      company: { secret: "mask" },
      castes: { engineer: { secret: "mask" } },
      agents: { [engineerAgentId]: { secret: "block" } },
    });
    const decision = await guardrailsOnRunOutput({
      db,
      companyId,
      runId: id,
      issueId: null,
      agentId: engineerAgentId,
      text,
      env: ENV_ON,
      now: FIXED_NOW,
    });
    expect(decision.mode).toBe("block");
    expect(decision.source).toBe("agent");
  });

  it("env force overrides every stored level and reports source env", async () => {
    const id = await seedRun();
    await storeModes({ agents: { [engineerAgentId]: { secret: "flag" } } });
    const decision = await guardrailsOnRunOutput({
      db,
      companyId,
      runId: id,
      issueId: null,
      agentId: engineerAgentId,
      text: secretText(),
      env: { ...ENV_ON, [GUARDRAILS_MODE_FORCE_ENV]: "mask" },
      now: FIXED_NOW,
    });
    expect(decision.mode).toBe("mask");
    expect(decision.source).toBe("env");
  });

  it("layer off: no decision regardless of modes", async () => {
    const id = await seedRun();
    await storeModes({ company: { secret: "block" } });
    const decision = await guardrailsOnRunOutput({
      db,
      companyId,
      runId: id,
      issueId: null,
      agentId: engineerAgentId,
      text: secretText(),
      env: {},
      now: FIXED_NOW,
    });
    expect(decision.hits).toBe(0);
    expect(decision.mode).toBe("flag");
    expect(decision.text).toBe(secretText());
    expect(await db.select().from(guardrailEvents)).toHaveLength(0);
  });

  it("pii-only text takes the pii rule's mode, not the secret mode", async () => {
    const id = await seedRun();
    await storeModes({
      company: { secret: "flag", pii: "mask" },
    });
    const decision = await guardrailsOnRunOutput({
      db,
      companyId,
      runId: id,
      issueId: null,
      agentId: engineerAgentId,
      text: "write to agent-a@example.com please",
      env: ENV_ON,
      now: FIXED_NOW,
    });
    expect(decision.rule).toBe("pii");
    expect(decision.mode).toBe("mask");
    expect(decision.text).toContain("[masked]");
    expect(decision.text).not.toContain("agent-a@example.com");
  });

  it("resolveGuardrailModeForAgent reads the agent's role from the agents table", async () => {
    await storeModes({ castes: { engineer: { secret: "block" } } });
    const enforcement = await resolveGuardrailModeForAgent({
      db,
      companyId,
      agentId: engineerAgentId,
      rule: "secret",
    });
    expect(enforcement).toMatchObject({ rule: "secret", mode: "block", source: "caste", caste: "engineer" });
  });

  it("settings storage round-trips through instance_settings.general.guardrailModes", async () => {
    const settings = instanceSettingsService(db);
    const initial = await readGuardrailModesSettings(settings);
    expect(initial).toEqual(normalizeGuardrailModesSettings(undefined));
    const stored = await writeGuardrailModesSettings(settings, {
      company: { pii: "mask" },
      castes: { engineer: { injection: "block" } },
      agents: {},
    });
    expect(stored).toMatchObject({ company: { pii: "mask" } });
    const reread = await readGuardrailModesSettings(settings);
    expect(reread).toEqual(stored);
    // Unwritable garbage in the row resolves to the all-flag default.
    await db
      .update(instanceSettings)
      .set({ general: { guardrailModes: { company: { secret: "nonsense" } } } })
      .where(eq(instanceSettings.singletonKey, "default"));
    expect(await readGuardrailModesSettings(settings)).toEqual(
      normalizeGuardrailModesSettings(undefined),
    );
  });
});

describe("myrmidon(1.7-GRD-MODES): maskGuardrailSpans (pure)", () => {
  it("replaces every non-overlapping span with the neutral placeholder", () => {
    const masked = maskGuardrailSpans("abcSECRETdefSECRETghi", [
      { span: [3, 9] },
      { span: [12, 18] },
    ]);
    expect(masked).toBe("abc[masked]def[masked]ghi");
  });

  it("handles unsorted and adjacent spans without losing text", () => {
    const masked = maskGuardrailSpans("0123456789", [
      { span: [5, 7] },
      { span: [1, 3] },
    ]);
    expect(masked).toBe("0[masked]34[masked]789");
  });

  it("returns the text unchanged for no spans", () => {
    expect(maskGuardrailSpans("same", [])).toBe("same");
  });

  it("clamps spans that run past the end", () => {
    const masked = maskGuardrailSpans("ab", [{ span: [1, 99] }]);
    expect(masked).toBe("a[masked]");
  });
});
