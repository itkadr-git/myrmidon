/**
 * myrmidon(1.6.5-F11-A): the media MCP server (tools/media-mcp) joins a bot's
 * profile only when the bot has a media token. The single token source is the
 * card env entry MEDIA_TOOLS_TOKEN (the frozen inter-part contract of
 * MEDIA-PROVISION, media-acl-export.ts: the board-side exporter hashes exactly
 * this entry into the facade's bots.json), so the compiler reads the resolved
 * card env and never mints, stores, or resolves a second company secret —
 * token issuing is the card-side operator flow, not the compiler's.
 *
 * A bot whose card carries no (or blank) MEDIA_TOOLS_TOKEN gets NO media MCP
 * block in its profile — so the runtime never registers a server that would
 * answer every call with HTTP 401 (the incident: ~1k `media … HTTP 401` lines
 * per hour across the fleet). Instead the compile records a signal in the
 * process-level registry below; the attention feed turns it into a card
 * («медиа не подключено»), the same pattern as
 * myrmidon(BOT-RUNTIME-TUNING D)'s model_fallback_alert. The bot-side client
 * (tools/media-mcp/bot-scripts/media_client.py) answers MediaNotConnectedError
 * instead of hammering the facade.
 */
import type { AttentionSeverity } from "@paperclipai/shared";

export const MEDIA_MCP_SERVER_NAME = "media";
export const MEDIA_MCP_TOKEN_ENV = "MEDIA_TOOLS_TOKEN";
export const MEDIA_MCP_URL_ENV = "MEDIA_TOOLS_URL";

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
    severity: "warning",
    title: "Media tools not connected",
    whyNow:
      "This bot's card has no MEDIA_TOOLS_TOKEN, so the media MCP block was left out of its profile and the " +
      "media scripts answer «медиа не подключено» instead of failing with HTTP 401. Add the token to the card's " +
      "env (MEDIA-PROVISION provisioning); the media ACL exporter then picks it up into bots.json and the next " +
      "compile pass includes the media block.",
    summaryExcerpt: `${MEDIA_MCP_TOKEN_ENV} is not set on the card; media block omitted from the profile`,
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
