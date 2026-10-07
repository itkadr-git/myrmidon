// server/src/myrmidon/bot-containers/bot-disk-cards.ts
//
// myrmidon(1.6.5 BOT-DISK-H4c): attention cards of the bot-disk lifecycle
// (epic design section 5, contract C7 `WS_CARD_KEYS`). Pure functions: a
// snapshot of what the bots reported (C4 `WsDiskReport`) plus the board's own
// facts in, cards out. The feed recomputes on every list, so a card exists
// exactly while its condition holds and disappears the moment it stops.
//
// Cards:
//   bot_disk_lifecycle/agent-silent  report older than 30 min on a running container (per bot)
//   bot_disk_lifecycle/drift         copy of a closed task alive longer than grace + 15 min
//   bot_disk_lifecycle/foreign       a class-X copy, at once (path + sign)
//   bot_disk_archive                 an archive of unpushed work, on the task
//   bot_image_stale                  bot image generation not current for more than 24 h
//
// Wording never carries remote URLs, tokens or free text of a bot: every
// string that came from a report goes through `redactReportText`.

import {
  WS_BOT_DISK_SETTING_DEFAULTS,
  WS_CARD_KEYS,
  type AttentionSeverity,
  type WsCardKey,
  type WsDiskReport,
  type WsReportCopy,
} from "@paperclipai/shared";

/** A report older than this on a running container raises `agent-silent`. */
export const BOT_DISK_AGENT_SILENT_MS = 30 * 60_000;
/** Drift is raised this long after the grace of a closing copy has run out. */
export const BOT_DISK_DRIFT_EXTRA_MS = 15 * 60_000;
/** A bot on a non-current image for longer than this raises `bot_image_stale`. */
export const BOT_IMAGE_STALE_MS = 24 * 3_600_000;
/** Archives live 30 days (design class F); an older one is not shown. */
export const BOT_DISK_ARCHIVE_TTL_MS = 30 * 24 * 3_600_000;

export type BotDiskCardSourceKind = "bot_disk_lifecycle" | "bot_disk_archive" | "bot_image_stale";

/** What the board knows about one bot: its last report and its desired state. */
export interface BotDiskBotSnapshot {
  /** The agent id (`botKeyForAgent`). */
  botKey: string;
  /** The bot container is running now. */
  running: boolean;
  /** When the board received the last report (ms); null = never. */
  receivedAtMs: number | null;
  /** The last accepted report (contract C4); null = none yet. */
  report: WsDiskReport | null;
  /**
   * Desired state (contract C3): issue key -> ISO time the task became
   * terminal / reassigned / PR-merged (`state: "closing"` + `since`). A copy
   * whose key is not in the map belongs to a live task and cannot drift.
   */
  closingSince?: Readonly<Record<string, string>>;
}

export interface BotDiskCardsInput {
  nowMs: number;
  bots: readonly BotDiskBotSnapshot[];
  /** `general.botDisk.graceClosingMinutes`; default from the contract. */
  graceClosingMinutes?: number;
  /** The current bot image generation and since when it is current; null = unknown (no stale card). */
  currentImage?: { generation: string; sinceMs: number } | null;
}

export interface BotDiskCard {
  sourceKind: BotDiskCardSourceKind;
  /** Contract C7 card key. */
  cardKey: WsCardKey;
  botKey: string;
  /** Archive cards sit on the task: its board key (e.g. ABC-101). */
  issueKey: string | null;
  dedupKey: string;
  severity: AttentionSeverity;
  title: string;
  whyNow: string;
  entryRule: string;
  exitRule: string;
  /** ISO time of the fact the card reports. */
  at: string;
  /** Always has `botKey` and `at` (contract C7); the rest is per card. */
  payload: { botKey: string; at: string } & Record<string, unknown>;
}

const MAX_TEXT = 200;

/**
 * Text that came from a bot or its report is data: drop credentials embedded
 * in URLs, token-shaped strings, e-mail addresses and long opaque blobs, and
 * cap the length. Paths and keys pass through unchanged.
 */
export function redactReportText(value: string): string {
  return value
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/gi, "<url>://")
    .replace(/\b(?:gh[pousr]_|github_pat_|glpat-|sk-|xox[abprs]-|AKIA)[A-Za-z0-9_-]{6,}/g, "<token>")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    .replace(/\b[A-Za-z0-9+/_=-]{40,}\b/g, "<blob>")
    .slice(0, MAX_TEXT);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function minutes(ms: number): number {
  return Math.floor(ms / 60_000);
}

function baseName(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function human(ms: number): string {
  const m = minutes(ms);
  if (m < 120) return `${m} min`;
  return `${Math.floor(m / 60)} h`;
}

/**
 * `agent-silent`: a running container that has sent reports before, and whose
 * last report is older than 30 minutes. A bot that never reported is not a card
 * (the disk agent is not rolled out yet).
 */
export function buildAgentSilentCards(input: BotDiskCardsInput): BotDiskCard[] {
  const cards: BotDiskCard[] = [];
  for (const bot of input.bots) {
    if (!bot.running) continue;
    const lastMs = bot.receivedAtMs;
    if (lastMs === null) continue;
    const ageMs = input.nowMs - lastMs;
    if (ageMs <= BOT_DISK_AGENT_SILENT_MS) continue;
    const at = iso(input.nowMs);
    cards.push({
      sourceKind: "bot_disk_lifecycle",
      cardKey: WS_CARD_KEYS.agentSilent,
      botKey: bot.botKey,
      issueKey: null,
      dedupKey: `${WS_CARD_KEYS.agentSilent}:${bot.botKey}`,
      severity: "medium",
      title: "Bot disk agent is silent",
      whyNow: `The bot is running but its disk agent last reported ${human(ageMs)} ago (limit 30 min), so its work copies are not being cleaned up.`,
      entryRule: "the bot container is running, it has reported before, and its last disk report is older than 30 minutes",
      exitRule: "the bot sends a fresh disk report or its container stops",
      at,
      payload: {
        botKey: bot.botKey,
        at,
        lastReportAt: iso(lastMs),
        ageMinutes: minutes(ageMs),
      },
    });
  }
  return cards;
}

function driftReason(copy: WsReportCopy, report: WsDiskReport): string {
  const skipped = [...report.actions]
    .reverse()
    .find((a) => a.path === copy.path && (a.result === "error" || a.result === "skipped") && a.detail);
  if (skipped?.detail) return redactReportText(skipped.detail);
  if (copy.reason) return redactReportText(copy.reason);
  if (copy.clean === false) return "the copy has uncommitted changes";
  if (copy.pushed === false) return "the copy has commits that are not pushed";
  return "the disk agent has not removed it and reports no reason";
}

/** `drift`: the copy of a closed task is alive longer than grace + 15 minutes. */
export function buildDriftCards(input: BotDiskCardsInput): BotDiskCard[] {
  const graceMin = input.graceClosingMinutes ?? WS_BOT_DISK_SETTING_DEFAULTS.graceClosingMinutes;
  const limitMs = graceMin * 60_000 + BOT_DISK_DRIFT_EXTRA_MS;
  const cards: BotDiskCard[] = [];
  for (const bot of input.bots) {
    if (!bot.report || !bot.closingSince) continue;
    for (const copy of bot.report.copies) {
      if (copy.class !== "E" || !copy.key) continue;
      const sinceIso = bot.closingSince[copy.key];
      if (!sinceIso) continue;
      const sinceMs = Date.parse(sinceIso);
      if (!Number.isFinite(sinceMs)) continue;
      const overMs = input.nowMs - sinceMs;
      if (overMs <= limitMs) continue;
      const reason = driftReason(copy, bot.report);
      const at = iso(sinceMs + limitMs);
      cards.push({
        sourceKind: "bot_disk_lifecycle",
        cardKey: WS_CARD_KEYS.drift,
        botKey: bot.botKey,
        issueKey: copy.key,
        dedupKey: `${WS_CARD_KEYS.drift}:${bot.botKey}:${copy.key}`,
        severity: "medium",
        title: `Work copy of closed task ${redactReportText(copy.key)} is still on disk`,
        whyNow: `Task ${redactReportText(copy.key)} closed ${human(overMs)} ago; its copy ${redactReportText(copy.path)} should have been removed after ${graceMin} min. Reason: ${reason}.`,
        entryRule: `a work copy of a closed task is alive longer than the grace of ${graceMin} min plus 15 min`,
        exitRule: "the copy is removed or archived by the disk agent, or the task is active again",
        at,
        payload: {
          botKey: bot.botKey,
          at,
          issueKey: copy.key,
          path: copy.path,
          closedAt: iso(sinceMs),
          overdueMinutes: minutes(overMs - graceMin * 60_000),
          reason,
          clean: copy.clean,
          pushed: copy.pushed,
        },
      });
    }
  }
  return cards;
}

/** `foreign`: a class-X copy (promisor, token in remote, no remote, trash, full clone), at once. */
export function buildForeignCards(input: BotDiskCardsInput): BotDiskCard[] {
  const cards: BotDiskCard[] = [];
  for (const bot of input.bots) {
    const report = bot.report;
    if (!report) continue;
    const reportAtMs = Date.parse(report.at);
    const at = iso(Number.isFinite(reportAtMs) ? reportAtMs : input.nowMs);
    const seen = new Map<string, string>(); // path -> sign
    for (const f of report.foreign) seen.set(f.path, f.sign);
    for (const c of report.copies) if (c.class === "X" && !seen.has(c.path)) seen.set(c.path, "unclassified");
    for (const [p, sign] of seen) {
      cards.push({
        sourceKind: "bot_disk_lifecycle",
        cardKey: WS_CARD_KEYS.foreign,
        botKey: bot.botKey,
        issueKey: null,
        dedupKey: `${WS_CARD_KEYS.foreign}:${bot.botKey}:${p}`,
        severity: sign === "token" ? "high" : "medium",
        title: "Foreign copy on a bot disk",
        whyNow: `${redactReportText(p)} is not a managed work copy (sign: ${redactReportText(sign)}). The disk agent archives and removes it after 24 h.`,
        entryRule: "the bot's disk report lists a copy outside the managed layout (class X)",
        exitRule: "the copy is removed or no longer reported",
        at,
        payload: { botKey: bot.botKey, at, path: p, sign },
      });
    }
  }
  return cards;
}

/** `bot_disk_archive`: one card per archive on its task; gone on restore or after 30 days. */
export function buildArchiveCards(input: BotDiskCardsInput): BotDiskCard[] {
  const cards: BotDiskCard[] = [];
  for (const bot of input.bots) {
    if (!bot.report) continue;
    for (const a of bot.report.archives) {
      const createdMs = Date.parse(a.createdAt);
      if (!Number.isFinite(createdMs)) continue;
      const expiresMs = createdMs + BOT_DISK_ARCHIVE_TTL_MS;
      if (input.nowMs >= expiresMs) continue;
      const at = iso(createdMs);
      cards.push({
        sourceKind: "bot_disk_archive",
        cardKey: WS_CARD_KEYS.archive,
        botKey: bot.botKey,
        issueKey: a.key,
        dedupKey: `${WS_CARD_KEYS.archive}:${bot.botKey}:${baseName(a.path)}`,
        severity: "low",
        title: `Unpushed work of ${redactReportText(a.key)} was archived`,
        whyNow: `The copy of ${redactReportText(a.key)} held unpushed work and was removed; it is kept as ${redactReportText(baseName(a.path))} (${a.sizeBytes} bytes) until ${iso(expiresMs)}. Restore it with myr-ws restore ${redactReportText(a.key)}.`,
        entryRule: "the disk agent archived a copy with unpushed work",
        exitRule: "the archive is restored, or expires after 30 days",
        at,
        payload: {
          botKey: bot.botKey,
          at,
          issueKey: a.key,
          path: a.path,
          sizeBytes: a.sizeBytes,
          expiresAt: iso(expiresMs),
        },
      });
    }
  }
  return cards;
}

/** `bot_image_stale`: image generation of the bot is not current for more than 24 h. */
export function buildImageStaleCards(input: BotDiskCardsInput): BotDiskCard[] {
  const current = input.currentImage;
  if (!current) return [];
  const staleMs = input.nowMs - current.sinceMs;
  if (staleMs <= BOT_IMAGE_STALE_MS) return [];
  const cards: BotDiskCard[] = [];
  for (const bot of input.bots) {
    if (!bot.report || bot.report.imageGeneration === current.generation) continue;
    const at = iso(current.sinceMs + BOT_IMAGE_STALE_MS);
    cards.push({
      sourceKind: "bot_image_stale",
      cardKey: WS_CARD_KEYS.imageStale,
      botKey: bot.botKey,
      issueKey: null,
      dedupKey: `${WS_CARD_KEYS.imageStale}:${bot.botKey}`,
      severity: "low",
      title: "Bot runs an old image generation",
      whyNow: `The bot runs image ${redactReportText(bot.report.imageGeneration)}, the current one is ${redactReportText(current.generation)} (for ${human(staleMs)}); the bot-disk functions of newer releases are missing on it.`,
      entryRule: "the bot's image generation is not the current one for more than 24 hours",
      exitRule: "the bot is recreated on the current image",
      at,
      payload: {
        botKey: bot.botKey,
        at,
        imageGeneration: redactReportText(bot.report.imageGeneration),
        currentGeneration: redactReportText(current.generation),
      },
    });
  }
  return cards;
}

/** All cards of the bot-disk lifecycle for one snapshot, in a stable order. */
export function buildBotDiskCards(input: BotDiskCardsInput): BotDiskCard[] {
  return [
    ...buildAgentSilentCards(input),
    ...buildDriftCards(input),
    ...buildForeignCards(input),
    ...buildArchiveCards(input),
    ...buildImageStaleCards(input),
  ];
}

// ---------------------------------------------------------------------------
// The reader. `readBotDiskReports()` is the seam to the report store (task
// H4b, route POST /api/myrmidon/bots/me/disk-report). It is registered there;
// until then the feed sees no snapshot and raises no card.
// ---------------------------------------------------------------------------

export interface BotDiskReportsReading {
  bots: BotDiskBotSnapshot[];
  currentImage?: { generation: string; sinceMs: number } | null;
  graceClosingMinutes?: number;
}

type BotDiskReportsReader = (companyId: string) => BotDiskReportsReading | Promise<BotDiskReportsReading>;

let reader: BotDiskReportsReader | null = null;

/** Registered by the report store (H4b). Pass null to unregister (tests). */
export function registerBotDiskReportsReader(next: BotDiskReportsReader | null): void {
  reader = next;
}

export async function readBotDiskReports(companyId: string): Promise<BotDiskReportsReading> {
  if (!reader) return { bots: [] };
  return reader(companyId);
}
