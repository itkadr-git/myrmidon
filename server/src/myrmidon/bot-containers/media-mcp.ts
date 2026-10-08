/**
 * myrmidon(1.6.5-F11-A): the media MCP server (tools/media-mcp) joins a bot's
 * profile only when the bot has an issued media token. The token is per bot
 * and lives in the instance's secret store under a deterministic name derived
 * from the bot key (`mediaTokenSecretName`); the compiler asks for it like it
 * asks for the LiteLLM key, so it is minted lazily and cached process-wide.
 *
 * A bot whose token is missing or rejected by the facade gets NO media MCP
 * block in its profile — so the runtime never registers a server that would
 * answer every call with HTTP 401 (the incident: ~1k `media … HTTP 401` lines
 * per hour across the fleet). Instead the compile records a signal in the
 * process-level registry below; the attention feed turns it into a card
 * («медиа не подключено»), the same pattern as
 * myrmidon(BOT-RUNTIME-TUNING D)'s model_fallback_alert. The bot-side client
 * (tools/media-mcp/bot-scripts/media_client.py) raises the matching
 * MediaNotConnectedError instead of hammering the facade.
 *
 * The deploy side builds the service's bots.json from the bots' cards with
 * `python -m media_mcp.registry` (tools/media-mcp/src/media_mcp/registry.py);
 * each registry entry names the environment variable that carries the live
 * token (`MEDIA_BOT_TOKEN_<KEY>`), which is the same token value this module
 * mints per bot. The registry file itself never holds a usable credential.
 */
import { createHash, randomBytes } from "node:crypto";

import type { AttentionSeverity } from "@paperclipai/shared";

export const MEDIA_MCP_SERVER_NAME = "media";
export const MEDIA_MCP_TOKEN_ENV = "MEDIA_TOOLS_TOKEN";
export const MEDIA_MCP_URL_ENV = "MEDIA_TOOLS_URL";

/** Deterministic company-secret name for a bot's media token. */
export function mediaTokenSecretName(botKey: string): string {
  return `MYRMIDON_MEDIA_TOKEN_${botKey.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

/** The deploy-side environment variable name for the same token (registry). */
export function mediaTokenEnvName(botKey: string): string {
  return `MEDIA_BOT_TOKEN_${botKey.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

/** Mints a new opaque bot token; only its sha256 reaches the registry. Used by
 *  the operator flow that issues a token (the company secret store write), not
 *  by the profile compiler, which only reads. */
export function mintMediaToken(): string {
  return `med_${randomBytes(24).toString("base64url")}`;
}

/** Fingerprint for logs/warnings; never log the token itself. */
export function mediaTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// The signal object the attention feed turns into a card
// ---------------------------------------------------------------------------

export interface MediaMcpAttentionSignal {
  dedupKey: string;
  agentId: string;
  botKey: string;
  severity: AttentionSeverity;
  title: string;
  whyNow: string;
  summaryExcerpt: string;
  /** ISO timestamp of the compile pass that produced the signal. */
  activityAt: string;
}

export function mediaMcpDedupKey(agentId: string): string {
  return `media-mcp:offline:${agentId}`;
}

export function mediaMcpSignalForBot(agentId: string, botKey: string, activityAt: string): MediaMcpAttentionSignal {
  return {
    dedupKey: mediaMcpDedupKey(agentId),
    agentId,
    botKey,
    severity: "medium",
    title: "Media tools not connected",
    whyNow:
      `This bot has no issued media token (${mediaTokenSecretName(botKey)}), so the media MCP block was left out of ` +
      "its profile and the media scripts will answer «медиа не подключено» instead of failing with HTTP 401. " +
      "Issue the token (rotate the company secret) and rebuild the media registry to connect media tools.",
    summaryExcerpt: `${MEDIA_MCP_TOKEN_ENV} is not set; media block omitted from the profile`,
    activityAt,
  };
}

// ---------------------------------------------------------------------------
// Process-level registry the attention feed reads. The bot-containers sweep
// brackets its compile pass with begin/end so the registry always mirrors the
// last pass: a bot whose token appears drops its card on the next pass.
// ---------------------------------------------------------------------------

const signalByCompany = new Map<string, MediaMcpAttentionSignal[]>();
let pendingByCompany = new Map<string, MediaMcpAttentionSignal[]>();
let passDepth = 0;

/** Starts one compile pass; signals recorded until endMediaMcpPass replace the previous pass's. */
export function beginMediaMcpPass(): void {
  passDepth += 1;
  if (passDepth === 1) pendingByCompany = new Map();
}

/** Records one bot's «media not connected» signal for the current pass. */
export function recordMediaMcpOffline(companyId: string, signal: MediaMcpAttentionSignal): void {
  if (passDepth === 0) {
    // Outside a pass (single compile, tests): update the live registry in place.
    const list = (signalByCompany.get(companyId) ?? []).filter((s) => s.agentId !== signal.agentId);
    list.push(signal);
    signalByCompany.set(companyId, list);
    return;
  }
  const list = (pendingByCompany.get(companyId) ?? []).filter((s) => s.agentId !== signal.agentId);
  list.push(signal);
  pendingByCompany.set(companyId, list);
}

/** Closes the pass: the recorded signals become the live set (per company). */
export function endMediaMcpPass(): void {
  if (passDepth === 0) return;
  passDepth -= 1;
  if (passDepth > 0) return;
  for (const companyId of new Set([...signalByCompany.keys(), ...pendingByCompany.keys()])) {
    const next = pendingByCompany.get(companyId) ?? [];
    if (next.length === 0) signalByCompany.delete(companyId);
    else signalByCompany.set(companyId, next);
  }
  pendingByCompany = new Map();
}

/** The company's current signals, or an empty array when none. */
export function readMediaMcpSignals(companyId: string): MediaMcpAttentionSignal[] {
  return signalByCompany.get(companyId) ?? [];
}

/** Forget every recorded signal: tests, and a sweep switch-off. */
export function resetMediaMcpSignals(): void {
  signalByCompany.clear();
  pendingByCompany = new Map();
  passDepth = 0;
}
