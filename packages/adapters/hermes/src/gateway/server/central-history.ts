// packages/adapters/hermes/src/gateway/server/central-history.ts
//
// myrmidon(MEMORY-CENTRAL-B): central session history for the hermes gateway.
//
// Why this exists: a gateway bot's conversation history lives in the container
// volume (the gateway's own per-session state under its HERMES_HOME). When the
// volume is recreated the history is gone — the board's session key still
// resumes, but on an empty store. With MYRMIDON_BOT_CENTRAL_HISTORY enabled,
// this module keeps a per-session record of finished turns in the bot's
// central hindsight bank (one memory per finished run, `document_id` = the
// stable session key) and injects the latest turns back into the wake input of
// the next run, so a fresh volume continues with the conversation context
// instead of losing it. When the setting is off, nothing here runs and the
// adapter behaves exactly as before.
//
// Storage choice (minimal edit): session records ride the memory bank the bot
// already has (the same hindsight service and bank the memory plugin and the
// memory card use), addressed exactly (list + `document_id` filter), not
// semantically — this is a transcript store, not recall. No new table, no
// container-side mount: the transport is the service's documented REST surface
// (the same paths the memory plugin's client uses).

import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const CENTRAL_HISTORY_ENABLED_ENV = "MYRMIDON_BOT_CENTRAL_HISTORY";
/** The shared hindsight address as the bot containers see it (profile-compiler's
 * own setting); the adapter server process reads the same value as a fallback. */
export const CENTRAL_HISTORY_BOT_URL_ENV = "MYRMIDON_BOT_HINDSIGHT_API_URL";
/** Board-level hindsight address (agent-memory settings). */
export const CENTRAL_HISTORY_URL_ENV = "MYRMIDON_HINDSIGHT_API_URL";
/** Default bank when neither the card nor the environment names one. */
export const CENTRAL_HISTORY_BOT_BANK_ENV = "MYRMIDON_BOT_HINDSIGHT_BANK";
/** Optional service key (self-hosted services without auth need none). */
export const CENTRAL_HISTORY_KEY_ENV = "HINDSIGHT_API_KEY";

const HISTORY_TAG = "myrmidon-session-history";
const DEFAULT_TIMEOUT_MS = 10_000;
/** How many stored turns are read back and rendered into one wake input. */
const DEFAULT_MAX_TURNS = 10;
/** Listing cap when reading back a session (the store is append-only, so a
 * bounded window from the tail is all the injection needs). */
const LIST_PAGE_LIMIT = 100;
/** Character cap of one turn's output in the rendered block. */
const TURN_CHAR_CAP = 4_000;
/** Character cap of the whole rendered block; the oldest turns are dropped
 * first so the freshest context survives truncation. */
const BLOCK_CHAR_CAP = 16_000;

export interface CentralHistorySettings {
  enabled: boolean;
  baseUrl: string | null;
  bankId: string | null;
  apiKey: string | null;
  maxTurns: number;
}

/** Truthy enable values, aligned with the repo's other MYRMIDON_* toggles. */
export function isTruthyFlag(value: string | undefined | null): boolean {
  if (value == null) return false;
  const raw = String(value).trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(50, Math.floor(parsed)));
}

function readHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return value;
}

/**
 * Resolve the setting surface: the enable flag and the connection triple are
 * read from the card's config first, then the card's injected `env` map (the
 * runtime environment the board writes for the run), then the process env of
 * the server process hosting the adapter. Missing address or bank while the
 * flag is on is reported as "not configured" (settings.enabled stays false);
 * the adapter then behaves as before — the feature cannot half-work into a
 * crash.
 */
export function readCentralHistorySettings(ctx: AdapterExecutionContext): CentralHistorySettings {
  const config = ctx.config ?? {};
  const env = asRecord(config.env) ?? {};
  const processEnv = process.env as Record<string, string | undefined>;

  const flagSources = [
    nonEmptyString(config.centralHistory),
    nonEmptyString(env[CENTRAL_HISTORY_ENABLED_ENV]),
    processEnv[CENTRAL_HISTORY_ENABLED_ENV] ?? null,
  ];
  const enabled = flagSources.some((flag) => isTruthyFlag(flag));

  const urlSources = [
    nonEmptyString(config.centralHistoryUrl),
    nonEmptyString(env[CENTRAL_HISTORY_BOT_URL_ENV]) ?? processEnv[CENTRAL_HISTORY_BOT_URL_ENV] ?? null,
    nonEmptyString(env[CENTRAL_HISTORY_URL_ENV]) ?? processEnv[CENTRAL_HISTORY_URL_ENV] ?? null,
  ];
  const baseUrl = readHttpUrl(urlSources.find((candidate): candidate is string => candidate !== null) ?? null);

  const hindsight = asRecord(config.hindsight);
  const bankSources = [
    nonEmptyString(config.centralHistoryBankId),
    hindsight ? nonEmptyString(hindsight["bankId"]) : null,
    nonEmptyString(env[CENTRAL_HISTORY_BOT_BANK_ENV]) ?? processEnv[CENTRAL_HISTORY_BOT_BANK_ENV] ?? null,
  ];
  const bankId = bankSources.find((candidate): candidate is string => candidate !== null) ?? null;

  const keySources = [
    nonEmptyString(config.centralHistoryApiKey),
    nonEmptyString(env[CENTRAL_HISTORY_KEY_ENV]) ?? processEnv[CENTRAL_HISTORY_KEY_ENV] ?? null,
  ];
  const apiKey = keySources.find((candidate): candidate is string => candidate !== null) ?? null;

  return {
    enabled: enabled && baseUrl !== null && bankId !== null,
    baseUrl,
    bankId,
    apiKey,
    maxTurns: parseNumber(config.centralHistoryMaxTurns, DEFAULT_MAX_TURNS),
  };
}

/** One stored session turn, as read back from the memory bank. */
export interface StoredSessionTurn {
  runId: string | null;
  savedAt: string;
  output: string;
}

function parseStoredTurn(raw: unknown): StoredSessionTurn | null {
  const row = asRecord(raw);
  if (!row) return null;
  const text = typeof row.text === "string" ? row.text : "";
  if (!text) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  const turn = asRecord(payload);
  if (!turn) return null;
  const output = nonEmptyString(turn["output"]);
  if (!output) return null;
  return {
    runId: nonEmptyString(turn["runId"]),
    savedAt: nonEmptyString(turn["savedAt"]) ?? "",
    output,
  };
}

/** Sort stored turns oldest-first; rows without a timestamp keep list order
 * (stable) but sort before timestamped ones — an unsorted tail must never
 * push the freshest turns out of the rendered block. */
export function sortTurnsOldestFirst(turns: StoredSessionTurn[]): StoredSessionTurn[] {
  return [...turns].sort((a, b) => {
    if (!a.savedAt && !b.savedAt) return 0;
    if (!a.savedAt) return -1;
    if (!b.savedAt) return 1;
    const ta = Date.parse(a.savedAt);
    const tb = Date.parse(b.savedAt);
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return -1;
    if (Number.isNaN(tb)) return 1;
    return ta - tb;
  });
}

/**
 * Render the restored-history block for a wake input: the freshest
 * `maxTurns` turns, oldest first, under a heading that tells the model the
 * conversation continues (the block is only injected when the session resumes
 * across a container rebuild — see execute.ts). Total output is capped; the
 * oldest turns are dropped first.
 */
export function renderRestoredHistory(turns: StoredSessionTurn[], maxTurns: number = DEFAULT_MAX_TURNS): string {
  const recent = sortTurnsOldestFirst(turns).slice(-Math.max(1, maxTurns));
  if (recent.length === 0) return "";
  const lines: string[] = [
    "## Restored session history (central store)",
    "",
    "The bot container was rebuilt and the gateway's own session state was reset.",
    "Your earlier turns in this task are restored below, oldest first, as the",
    "central store recorded them. Continue from them; do not repeat finished work.",
    "",
  ];
  const body: string[] = [];
  for (const turn of recent) {
    const output = turn.output.length > TURN_CHAR_CAP
      ? `${turn.output.slice(0, TURN_CHAR_CAP - 1)}…`
      : turn.output;
    body.push(`### Turn${turn.runId ? ` (run ${turn.runId})` : ""}${turn.savedAt ? ` — ${turn.savedAt}` : ""}\n\n${output}`);
  }
  // Drop the oldest blocks until the whole fits the cap.
  while (body.length > 0) {
    const candidate = [...lines, ...body].join("\n\n");
    if (candidate.length <= BLOCK_CHAR_CAP) return candidate;
    body.shift();
  }
  return "";
}

export interface CentralHistoryClient {
  saveTurn(input: { sessionKey: string; runId: string; output: string; model?: string | null }): Promise<void>;
  loadTurns(input: { sessionKey: string; maxTurns?: number }): Promise<StoredSessionTurn[]>;
}

/**
 * Build the client for one execution. Returns null when the setting is off or
 * not fully configured — every call site then keeps the previous behaviour.
 * The fetch is injectable so tests never reach a real service.
 */
export function createCentralHistoryClient(
  settings: CentralHistorySettings,
  deps: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): CentralHistoryClient | null {
  if (!settings.enabled || !settings.baseUrl || !settings.bankId) return null;
  const baseUrl = settings.baseUrl.replace(/\/+$/, "");
  const bankPath = `/v1/default/banks/${encodeURIComponent(settings.bankId)}`;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const headers = (): Record<string, string> => {
    const out: Record<string, string> = { "Content-Type": "application/json" };
    if (settings.apiKey) out["Authorization"] = `Bearer ${settings.apiKey}`;
    return out;
  };

  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status} from ${path}: ${text.slice(0, 200)}`);
      }
      const payload = await response.json().catch(() => null);
      return payload;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async saveTurn({ sessionKey, runId, output, model }) {
      const record = {
        schema: "myrmidon-session-turn-v1",
        runId,
        savedAt: new Date().toISOString(),
        model: model ?? null,
        output,
      };
      await request("POST", `${bankPath}/memories`, {
        items: [
          {
            content: JSON.stringify(record),
            context: `myrmidon session history for ${sessionKey}`,
            document_id: sessionKey,
            metadata: { tags: [HISTORY_TAG], kind: "session-turn" },
          },
        ],
        async: false,
      });
    },
    async loadTurns({ sessionKey, maxTurns }) {
      const params = new URLSearchParams({ limit: String(LIST_PAGE_LIMIT), offset: "0" });
      const payload = asRecord(await request("GET", `${bankPath}/memories/list?${params.toString()}`));
      const items = Array.isArray(payload?.["items"]) ? (payload["items"] as unknown[]) : [];
      const own = items.filter((item) => {
        const row = asRecord(item);
        return row !== null && nonEmptyString(row["document_id"] ?? row["doc_id"]) === sessionKey;
      });
      const turns = own
        .map(parseStoredTurn)
        .filter((turn): turn is StoredSessionTurn => turn !== null);
      const cap = Math.max(1, maxTurns ?? settings.maxTurns ?? DEFAULT_MAX_TURNS);
      return sortTurnsOldestFirst(turns).slice(-cap);
    },
  };
}