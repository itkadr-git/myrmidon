// myrmidon(GOOGLE-AI-CONNECT-UI): connector state storage.
//
// State lives under our own key of instance_settings.general (the same rule as
// the cloud connector and the Telegram notify settings): the vendor settings
// service strips unknown keys, so this module reads and writes the raw row
// itself. No migrations — an old image keeps working on the new schema.
//
// The document carries NO secret material: the owner's cookie bundle lives in
// a company secret of the instance secret store and the document keeps the
// secret id only. Journal rows carry agent ids, capability names and short
// value-free outcome text.

import { eq, sql } from "drizzle-orm";
import { agents, instanceSettings, type Db } from "@paperclipai/db";
import type {
  GaiConnection,
  GaiGrant,
  GaiJournalEntry,
} from "@paperclipai/shared/myrmidon-google-ai-connector";

export const GOOGLE_AI_CONNECTOR_GENERAL_KEY = "myrmidonGoogleAiConnector";

const SINGLETON_KEY = "default";
const JOURNAL_LIMIT = 200;

export interface GoogleAiConnectorDocument {
  version: 1;
  /** One connection per company: the owner authorized one Google account. */
  connections: GaiConnection[];
  grants: GaiGrant[];
  journal: GaiJournalEntry[];
}

export function emptyGoogleAiConnectorDocument(): GoogleAiConnectorDocument {
  return { version: 1, connections: [], grants: [], journal: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseConnection(value: unknown): GaiConnection | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const companyId = str(value.companyId);
  const secretId = str(value.secretId);
  const connectedAt = str(value.connectedAt);
  const connectedBy = str(value.connectedBy);
  if (!id || !companyId || !secretId || !connectedAt || !connectedBy) return null;
  const status = value.status;
  const lastSession = value.lastSession;
  return {
    id,
    companyId,
    status: status === "stale" || status === "error" ? status : "connected",
    secretId,
    connectedAt,
    connectedBy,
    lastCheckedAt: str(value.lastCheckedAt),
    lastSession: lastSession === "ok" || lastSession === "stale" ? lastSession : null,
    lastError: str(value.lastError),
  };
}

function parseGrant(value: unknown): GaiGrant | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const companyId = str(value.companyId);
  const capability = str(value.capability);
  const createdAt = str(value.createdAt);
  const createdBy = str(value.createdBy);
  if (!id || !companyId || !createdAt || !createdBy) return null;
  if (capability !== "generate_image" && capability !== "generate_video" && capability !== "creative_text") return null;
  const targetKind = value.targetKind;
  if (targetKind !== "agent" && targetKind !== "caste" && targetKind !== "all") return null;
  return {
    id,
    companyId,
    capability: capability as GaiGrant["capability"],
    targetKind,
    agentId: str(value.agentId),
    caste: str(value.caste),
    createdAt,
    createdBy,
  };
}

function parseJournalEntry(value: unknown): GaiJournalEntry | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const at = str(value.at);
  const actor = str(value.actor);
  const action = str(value.action);
  if (!id || !at || !actor || !action) return null;
  return {
    id,
    at,
    actor,
    actorKind: value.actorKind === "owner" ? "owner" : "agent",
    action,
    ok: value.ok === true,
    detail: str(value.detail) ?? "",
  };
}

/** Read defensively: anything malformed reads as an empty document. */
export function parseGoogleAiConnectorDocument(raw: unknown): GoogleAiConnectorDocument {
  if (!isRecord(raw)) return emptyGoogleAiConnectorDocument();
  const list = <T>(value: unknown, parse: (entry: unknown) => T | null): T[] =>
    Array.isArray(value) ? value.map(parse).filter((entry): entry is T => entry !== null) : [];
  return {
    version: 1,
    connections: list(raw.connections, parseConnection),
    grants: list(raw.grants, parseGrant),
    journal: list(raw.journal, parseJournalEntry),
  };
}

export interface GoogleAiConnectorStore {
  read(): Promise<GoogleAiConnectorDocument>;
  mutate<T>(
    change: (current: GoogleAiConnectorDocument) => { next: GoogleAiConnectorDocument | null; result: T },
  ): Promise<{ doc: GoogleAiConnectorDocument; result: T; changed: boolean }>;
}

export function dbGoogleAiConnectorStore(db: Db): GoogleAiConnectorStore {
  return {
    read: () => readGoogleAiConnectorDocument(db),
    mutate: (change) => mutateGoogleAiConnectorDocument(db, change),
  };
}

/**
 * The board role of an agent: the label a `caste` grant matches on. One
 * primary-key read per call; an unknown agent reads as "no caste", so a caste
 * grant can never match by accident.
 */
export function agentRoleFromDb(db: Db): (agentId: string) => Promise<string | null> {
  return async (agentId) => {
    const [row] = await db
      .select({ role: agents.role })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    return row?.role ?? null;
  };
}

/** In-memory store: used by tests and by any read-only embedding of the module. */
export function memoryGoogleAiConnectorStore(
  initial?: GoogleAiConnectorDocument,
): GoogleAiConnectorStore {
  let document = initial ?? emptyGoogleAiConnectorDocument();
  return {
    read: async () => document,
    mutate: async (change) => {
      const { next, result } = change(document);
      if (next) document = next;
      return { doc: document, result, changed: next !== null };
    },
  };
}

/** Keep our key across vendor writes of `instance_settings.general` (see instance-settings.ts). */
export function preserveGoogleAiConnectorGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[GOOGLE_AI_CONNECTOR_GENERAL_KEY];
  return value === undefined ? {} : { [GOOGLE_AI_CONNECTOR_GENERAL_KEY]: value };
}

type Runner = Pick<Db, "select" | "insert" | "update">;

export async function readGoogleAiConnectorDocument(db: Runner): Promise<GoogleAiConnectorDocument> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return parseGoogleAiConnectorDocument(row?.general?.[GOOGLE_AI_CONNECTOR_GENERAL_KEY]);
}

/**
 * Read-modify-write under a row lock: the change callback sees the current
 * document and returns the next one (or null to keep the stored value).
 */
export async function mutateGoogleAiConnectorDocument<T>(
  db: Db,
  change: (current: GoogleAiConnectorDocument) => { next: GoogleAiConnectorDocument | null; result: T },
): Promise<{ doc: GoogleAiConnectorDocument; result: T; changed: boolean }> {
  return db.transaction(async (tx) => {
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
    const current = parseGoogleAiConnectorDocument(row.general?.[GOOGLE_AI_CONNECTOR_GENERAL_KEY]);
    const { next, result } = change(current);
    if (!next) return { doc: current, result, changed: false };
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${GOOGLE_AI_CONNECTOR_GENERAL_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return { doc: next, result, changed: true };
  });
}
