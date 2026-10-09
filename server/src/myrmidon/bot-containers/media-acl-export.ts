// server/src/myrmidon/bot-containers/media-acl-export.ts
//
// myrmidon(MEDIA-PROVISION): the board-side exporter of the media ACL registry.
//
// The media MCP facade (tools/media-mcp) authenticates every bot container by a
// bearer token whose sha256 is listed in its `bots.json`, optionally keyed by
// the docker-DNS name of the container too. Until now that file was maintained
// by hand; this module makes the board generate it from the fleet's cards: each
// bot whose card env resolves a non-empty MEDIA_TOOLS_TOKEN gets one registry
// entry {token_sha256, peer_host, tools}. The raw token is never written and
// never logged — the file carries only its sha256. The exporter does NOT create
// tokens: provisioning is the separate card-side half of the track, so a bot
// without a token is simply absent from the registry.
//
// The hook runs once per reconciliation tick, next to the existing sweep work
// (index.ts). The card-env resolver behind `resolveCardEnv` caches per agent
// and re-resolves only when a binding or a secret version changes, so the
// steady-state cost of a tick is the one agents query this module adds. The
// file is rewritten only when its text actually changed, so the facade's
// mtime-based reload (media-mcp config.py) sees exactly the card changes and
// the mtime does not churn every interval.
//
// Pure over injected ports (the fleet list + the card-env resolver); the fs
// helpers are the only I/O besides the injected query, so the unit test covers
// the module with a temp directory and fakes.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { agents, type Db } from "@paperclipai/db";
import { and, eq, ne, sql } from "drizzle-orm";
import type { HermesProfileEnvEntry } from "./profile-compiler.js";
import type { BotProfileAgentRecord } from "./profile-compile.js";
import { botKeyForAgent, isBotContainersEnabled } from "./agent-config.js";
import { HERMES_GATEWAY_ADAPTER_TYPE } from "./agents-query.js";
import { containerNameFor } from "./template.js";

/** The card-env secret name a bot's media token is bound to (shared with the
 *  provisioning half of the track; the frozen inter-part contract). */
export const MEDIA_TOOLS_TOKEN_ENV = "MEDIA_TOOLS_TOKEN";

/** Board-side env var naming the registry file. Its default is the facade's
 *  own MEDIA_BOTS_FILE default ("/config/bots.json"), so one bind mount of the
 *  same path shared into the facade container needs no second setting. */
export const MYRMIDON_MEDIA_BOTS_FILE_ENV = "MYRMIDON_MEDIA_BOTS_FILE";
export const DEFAULT_MEDIA_BOTS_FILE = "/config/bots.json";

/** The default tools allowlist an exported entry carries, mirroring
 *  tools/media-mcp/config.example.json (the token-authenticated example bot).
 *  The exporter rewrites the file, so a hand-narrowed entry comes back on the
 *  next pass: per-bot narrowing needs a card knob of its own (out of this
 *  part's scope; noted in the docs fragment). */
export const DEFAULT_MEDIA_TOOLS_ALLOWLIST: readonly string[] = [
  "file_put",
  "file_get",
  "file_list",
  "file_delete",
  "media_probe",
  "ffmpeg_submit",
  "job_status",
  "job_cancel",
  "audio_split",
  "stt_transcribe",
  "image_transform",
];

/** sha256 of the raw token text, lowercase hex — the form the facade compares
 *  against (`hashlib.sha256(bearer).hexdigest()`). */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** One exported registry entry, before serialisation. */
export interface MediaAclEntry {
  botKey: string;
  tokenSha256: string;
  peerHost: string;
  tools: readonly string[];
}

/** The agents the registry is built from: the same fleet the reconciler sweeps
 *  (`hermes_gateway`, `container.enabled` true, never terminated — the filter
 *  of agents-query.ts) plus the columns of a card record (profile-compile.ts
 *  `BotProfileAgentRecord`), which is what the card-env resolver reads. */
export interface MediaAclAgent {
  agentId: string;
  companyId: string;
  name: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
}

/** The fleet query behind the exporter's `listAgents` (its own query on
 *  purpose: the reconcile list of agents-query.ts selects only the `container`
 *  sub-object, and a card-env resolve needs the whole card, the same record
 *  shape the profile ports load by id). */
export function listMediaAclAgents(db: Db): () => Promise<MediaAclAgent[]> {
  return async () => {
    const rows = await db
      .select({
        agentId: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
        runtimeConfig: agents.runtimeConfig,
      })
      .from(agents)
      .where(
        and(
          eq(agents.adapterType, HERMES_GATEWAY_ADAPTER_TYPE),
          ne(agents.status, "terminated"),
          sql`${agents.adapterConfig} #> '{container,enabled}' = 'true'::jsonb`,
        ),
      );
    return rows.map((row) => ({
      agentId: row.agentId,
      companyId: row.companyId,
      name: row.name,
      adapterType: row.adapterType,
      adapterConfig: row.adapterConfig as unknown as Record<string, unknown>,
      runtimeConfig: row.runtimeConfig as unknown as Record<string, unknown>,
    }));
  };
}

/** What the exporter reads out of a resolved card env — exactly the
 *  `resolveCardEnv` port of BotProfilePorts (card-env.ts resolver / profile
 *  ports), so the exporter shares the profile compiler's per-agent cache and
 *  secret-stamp validation instead of paying a second resolve per tick. */
export type MediaAclCardEnvResolver = (
  agent: BotProfileAgentRecord,
) => Promise<{ env: Record<string, HermesProfileEnvEntry> }>;

/** The one token read point: a card env entry counts only when its value is
 *  non-empty after trimming whitespace. */
export function mediaTokenFromEnv(env: Record<string, HermesProfileEnvEntry | undefined>): string | null {
  const value = env[MEDIA_TOOLS_TOKEN_ENV]?.value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The registry text the file carries: bot keys sorted, so equal cards always
 *  produce byte-equal text (the snapshot property; the facade reloads on mtime
 *  and must not see churn when nothing changed). */
export function buildBotsRegistryJson(entries: readonly MediaAclEntry[]): string {
  const bots: Record<string, { token_sha256: string; peer_host: string; tools: string[] }> = {};
  for (const key of [...new Set(entries.map((entry) => entry.botKey))].sort()) {
    const found = entries.find((entry) => entry.botKey === key)!;
    bots[key] = {
      token_sha256: found.tokenSha256,
      peer_host: found.peerHost,
      tools: [...found.tools],
    };
  }
  return `${JSON.stringify({ bots }, null, 2)}\n`;
}

/** Collects the registry entries for one fleet snapshot. An agent whose id
 *  cannot be a bot key is skipped (ids are lowercase uuids, which always can).
 *  A card with no (or blank) token contributes nothing. A card-env resolve
 *  that throws is counted in `failedResolves` and skipped: one broken binding
 *  must not empty the registry of the whole fleet. The raw token exists only
 *  inside this function, hashed straight into the entry. */
export async function collectMediaAclEntries(
  fleet: readonly MediaAclAgent[],
  resolveCardEnv: MediaAclCardEnvResolver,
  tools: readonly string[] = DEFAULT_MEDIA_TOOLS_ALLOWLIST,
): Promise<{ entries: MediaAclEntry[]; failedResolves: number }> {
  const entries: MediaAclEntry[] = [];
  let failedResolves = 0;
  for (const agent of fleet) {
    const botKey = botKeyForAgent(agent.agentId);
    if (!botKey) continue;
    let env: Record<string, HermesProfileEnvEntry>;
    try {
      ({ env } = await resolveCardEnv({
        id: agent.agentId,
        companyId: agent.companyId,
        name: agent.name,
        adapterType: agent.adapterType,
        adapterConfig: agent.adapterConfig,
        runtimeConfig: agent.runtimeConfig,
      }));
    } catch {
      failedResolves += 1;
      continue;
    }
    const token = mediaTokenFromEnv(env);
    if (!token) continue;
    entries.push({
      botKey,
      tokenSha256: sha256Hex(token),
      peerHost: containerNameFor(botKey),
      tools,
    });
  }
  return { entries, failedResolves };
}

/** Atomic write: a sibling temp file, re-stamped to 0600 (writeFile silently
 *  keeps the mode of a pre-existing file, e.g. a temp name left by a crashed
 *  pass), then rename — atomic within one directory, which the path keeps it
 *  in. The facade must never observe a half-written registry, and the file
 *  carries secret hashes, so it never gets a group/other-readable mode. */
export async function writeBotsFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmpPath, content, { mode: 0o600 });
  await fs.chmod(tmpPath, 0o600);
  await fs.rename(tmpPath, filePath);
}

/** The resolved file mode of the registry, or null when it does not exist. */
async function fileModeOrNull(filePath: string): Promise<number | null> {
  try {
    return (await fs.stat(filePath)).mode & 0o777;
  } catch {
    return null;
  }
}

export interface MediaAclExportResult {
  /** Where the registry was written (path from env or the default). */
  path: string;
  bots: number;
  /** Cards whose env failed to resolve this pass. */
  failedResolves: number;
  /** False when the file already carried exactly this text and mode (no mtime churn). */
  changed: boolean;
}

export interface MediaAclExportDeps {
  listAgents: () => Promise<MediaAclAgent[]>;
  resolveCardEnv: MediaAclCardEnvResolver;
  /** Registry path: explicit first, else MYRMIDON_MEDIA_BOTS_FILE_ENV, then
   *  DEFAULT_MEDIA_BOTS_FILE (the facade's own default). */
  env?: NodeJS.ProcessEnv;
  path?: string;
  tools?: readonly string[];
  /** Test hook for the process flag; production passes none (process.env). */
  containersEnabled?: (env: NodeJS.ProcessEnv) => boolean;
}

/** Registry path resolution: explicit first, then MYRMIDON_MEDIA_BOTS_FILE_ENV,
 *  then DEFAULT_MEDIA_BOTS_FILE (the facade's own default). Pure — the contract
 *  is asserted without ever touching the write path. */
export function resolveMediaBotsFilePath(env: NodeJS.ProcessEnv, explicit?: string): string {
  if (explicit !== undefined) return explicit;
  const fromEnv = env[MYRMIDON_MEDIA_BOTS_FILE_ENV]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_MEDIA_BOTS_FILE;
}

/**
 * One export pass: read the fleet, hash the card tokens, write the registry
 * when its text or mode changed. Returns null while the bot-container flag is
 * off (the whole reconciler, and with it this hook, is off then). Throws only
 * on a real write failure; the sweep catches it, records it and keeps the old
 * file, which the facade keeps serving.
 */
export async function runMediaAclExport(deps: MediaAclExportDeps): Promise<MediaAclExportResult | null> {
  const env = deps.env ?? process.env;
  if (!(deps.containersEnabled ?? isBotContainersEnabled)(env)) return null;
  const resolved = resolveMediaBotsFilePath(env, deps.path);
  const fleet = await deps.listAgents();
  const { entries, failedResolves } = await collectMediaAclEntries(
    fleet,
    deps.resolveCardEnv,
    deps.tools ?? DEFAULT_MEDIA_TOOLS_ALLOWLIST,
  );
  const text = buildBotsRegistryJson(entries);
  let current: string | null;
  try {
    current = await fs.readFile(resolved, "utf8");
  } catch {
    current = null;
  }
  const mode = await fileModeOrNull(resolved);
  if (current === text && mode === 0o600) {
    return { path: resolved, bots: entries.length, failedResolves, changed: false };
  }
  await writeBotsFileAtomic(resolved, text);
  return { path: resolved, bots: entries.length, failedResolves, changed: true };
}
