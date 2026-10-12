// myrmidon(1.6.6 KNOWLEDGE-2.0 K-7): the pilot agent set of the skill
// lifecycle, stored on the board instead of the environment.
//
// §5.5 / the K-7 criteria: `MYRMIDON_SKILL_PILOT_AGENTS` in env becomes a UI
// setting. The env var keeps working (it is the deploy-time source, and ops
// automation still reads it); the stored per-company list takes precedence for
// a company once the board has written it, and an explicitly-stored empty list
// means "no pilot" even while env carries ids. The storage is the same raw key
// of `instance_settings.general` every myrmidon track uses (canary, autonomy):
// the vendor settings service strips unknown keys, so this module reads and
// writes the row itself and instance-settings.ts carries the key over a vendor
// write (see preserveSkillPilotAgentsGeneralKey and the call site there).

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";

export const SKILL_PILOT_AGENTS_GENERAL_KEY = "myrmidonSkillPilotAgents";
const SINGLETON_KEY = "default";

type Runner = Pick<Db, "select">;

/** The stored area: companyId → agent id list. A missing company entry means
 *  "not configured on the board" — the env fallback applies for that company. */
export type SkillPilotAgentsByCompany = Record<string, string[]>;

function parseDocument(raw: unknown): SkillPilotAgentsByCompany {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: SkillPilotAgentsByCompany = {};
  for (const [companyId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    out[companyId] = [
      ...new Set(
        value
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      ),
    ];
  }
  return out;
}

export async function readSkillPilotAgentsByCompany(
  db: Runner,
): Promise<SkillPilotAgentsByCompany> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return parseDocument(row?.general?.[SKILL_PILOT_AGENTS_GENERAL_KEY]);
}

export async function readCompanySkillPilotAgents(
  db: Runner,
  companyId: string,
): Promise<string[] | null> {
  const area = await readSkillPilotAgentsByCompany(db);
  return Object.prototype.hasOwnProperty.call(area, companyId) ? area[companyId]! : null;
}

/** Replace the stored pilot list of one company (an empty array is a valid,
 *  explicit "no pilot"). Read-modify-write under a row lock, like canary. */
export async function setCompanySkillPilotAgents(
  db: Db,
  companyId: string,
  agentIds: readonly string[],
): Promise<string[]> {
  const clean = [...new Set(agentIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  await db.transaction(async (tx) => {
    await tx
      .insert(instanceSettings)
      .values({ singletonKey: SINGLETON_KEY, general: {}, experimental: {} })
      .onConflictDoNothing({ target: [instanceSettings.singletonKey] });
    const row = await tx
      .select({ id: instanceSettings.id, general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
      .for("update")
      .then((rows) => rows[0]!);
    const area = parseDocument(row.general?.[SKILL_PILOT_AGENTS_GENERAL_KEY]);
    area[companyId] = clean;
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${SKILL_PILOT_AGENTS_GENERAL_KEY}}`}::text[], ${JSON.stringify(area)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
  });
  return clean;
}

/** Carry our key over a vendor write of instance_settings.general. */
export function preserveSkillPilotAgentsGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[SKILL_PILOT_AGENTS_GENERAL_KEY];
  return value === undefined ? {} : { [SKILL_PILOT_AGENTS_GENERAL_KEY]: value };
}
