// server/src/myrmidon/bot-containers/bot-disk-physical-routes.ts
//
// myrmidon(1.6.6 SETTINGS-UI B / OPE-6258): the read side of the bot-disk
// lifecycle screen — `GET /api/myrmidon/bot-disk/physical` and
// `GET /api/myrmidon/bot-disk/reports`, the two routes the UI client
// (`ui/src/components/myrmidon/botDiskLifecycleApi.ts`) already expects.
//
// CONTRACT C5 (docs/myrmidon/bot-disk-contract): dockergate owns host capacity
// and per-project usage and answers `GET /myrmidon/disk` with
// `wsDiskApiResponseSchema`. The board is the viewer's window onto that answer
// (design §1.2: the board computes nothing disk-related): it relays the payload
// unchanged and adds the stored lifecycle settings so the screen fills in one
// round trip. The env vars naming the gate base URL and the board→gate token
// are forced by deployment; with either absent the relay is inert.
//
// A failure is data, not an error: the client header says an undeployed route
// or an old payload "must never break the UI". No base URL, an unreachable
// gate, a non-200 answer or a timeout all yield 200 with an empty snapshot and
// `gateReached: false`; the screen shows "no data".
//
// `GET /api/myrmidon/bot-disk/reports` returns the stored C4 rows (botd's POST
// /api/myrmidon/bots/me/disk-report, BOT-DISK-H4b): each bot's last report as
// received, with the board's receive time so the screen can mark a bot that
// has gone silent (BOT_DISK_REPORT_STALE_MS) and age out archives past the
// 30-day retention (BOT_DISK_ARCHIVE_RETENTION_MS).

import http from "node:http";
import https from "node:https";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { WsDiskApiResponse } from "@paperclipai/shared";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { readBotDiskReports } from "./bot-disk-report-store.js";
import { botDiskService } from "./bot-disk-service.js";

/** Mirror of `BOT_DISK_REPORT_STALE_MS` in the UI lifecycle client (the server cannot import `ui/`). */
const REPORT_STALE_MS = 30 * 60 * 1000;

/** The env var naming the dockergate base URL (contract C0). */
export const DOCKERGATE_BASE_URL_ENV = "MYRMIDON_DOCKERGATE_BASE_URL";
/** The env var with the board→dockergate token (contract C0). */
export const DOCKERGATE_TOKEN_ENV = "MYRMIDON_DOCKERGATE_TOKEN";

/** The gate must answer within this window; a slow gate means "no data". */
export const BOT_DISK_PHYSICAL_TIMEOUT_MS = 5_000;

/** A larger gate answer is not the disk payload; treat it as no data. */
const PHYSICAL_MAX_BODY_BYTES = 2 * 1024 * 1024;

/** The C5 relay plus the board's own additions (relayed fields optional for old gates). */
export interface BotDiskPhysicalSnapshot {
  /** C5: the partition the bot projects live on (relayed unchanged). */
  partition?: WsDiskApiResponse["partition"];
  /** C5: per-project usage (relayed unchanged; empty without a gate answer). */
  projects?: WsDiskApiResponse["projects"];
  /** C5: usage not attributable to any project (relayed unchanged). */
  other?: WsDiskApiResponse["other"];
  /** C5: whether prjquota is on (relayed unchanged; false without a gate). */
  quotaEnabled?: boolean;
  /** C5: when the gate measured (relayed unchanged). */
  at?: string;
  /** The stored lifecycle+layout settings in force (same answer as GET /api/myrmidon/bot-disk). */
  lifecycle?: Record<string, unknown>;
  /** True when the board got a C5 answer from the gate on this call. */
  gateReached: boolean;
  /** Why the snapshot is empty when it is (shown as "no data" on the screen). */
  note?: string;
}

function getJson(
  baseUrl: string,
  token: string,
  path: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      url,
      { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" }, timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          finish(null);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > PHYSICAL_MAX_BODY_BYTES) {
            finish(null);
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            finish(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null);
          } catch {
            finish(null);
          }
        });
        res.on("error", () => finish(null));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      finish(null);
    });
    req.on("error", () => finish(null));
    req.end();
  });
}

export function botDiskPhysicalRoutes(
  db: Db,
  overrides: {
    env?: Record<string, string | undefined>;
    fetchGate?: (path: string) => Promise<Record<string, unknown> | null>;
    timeoutMs?: number;
  } = {},
) {
  const router = Router();
  const service = botDiskService(db);
  const env = overrides.env ?? process.env;

  const fetchGate =
    overrides.fetchGate ??
    ((path: string) => {
      const baseUrl = env[DOCKERGATE_BASE_URL_ENV]?.trim();
      const token = env[DOCKERGATE_TOKEN_ENV]?.trim();
      if (!baseUrl || !token) return Promise.resolve(null);
      return getJson(baseUrl, token, path, overrides.timeoutMs ?? BOT_DISK_PHYSICAL_TIMEOUT_MS);
    });

  // CONTRACT C5 relay: partition + projects + other + quota flag from the gate,
  // stored lifecycle settings riding along. Relayed fields are never rewritten.
  router.get("/myrmidon/bot-disk/physical", async (req, res) => {
    assertBoardOrgAccess(req);
    const gate = await fetchGate("myrmidon/disk");
    const view = await service.read().catch(() => null);
    const base: BotDiskPhysicalSnapshot = { lifecycle: view?.settings as Record<string, unknown> | undefined, gateReached: gate !== null };
    if (gate === null) {
      const configured = Boolean(env[DOCKERGATE_BASE_URL_ENV]?.trim() && env[DOCKERGATE_TOKEN_ENV]?.trim());
      res.json({ ...base, note: configured ? "gate unreachable" : "gate not configured" });
      return;
    }
    const p = gate as Partial<WsDiskApiResponse>;
    res.json({
      ...base,
      partition: p.partition,
      projects: Array.isArray(p.projects) ? p.projects : [],
      other: p.other,
      quotaEnabled: p.quotaEnabled === true,
      at: p.at,
    } satisfies BotDiskPhysicalSnapshot);
  });

  // CONTRACT C4 stored side: one row per bot that has reported, with the
  // board's receive time and the staleness window for the screen.
  router.get("/myrmidon/bot-disk/reports", async (req, res) => {
    assertBoardOrgAccess(req);
    const reports = readBotDiskReports()
      .map((entry) => ({ ...entry.report, receivedAt: entry.receivedAt }))
      .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
    res.json({ reports, staleAfterMs: REPORT_STALE_MS });
  });

  return router;
}

/** Router for app.ts, mounted under /api. */
export function myrmidonBotDiskPhysicalRoutes(db: Db) {
  return botDiskPhysicalRoutes(db);
}
