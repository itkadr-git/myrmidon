// server/src/myrmidon/bot-containers/bot-disk-report-routes.ts
//
// myrmidon(1.6.5-BOT-DISK-H4b): the botd disk-report ingest (C4) and the two
// board-side reads the «Диск ботов» panel needs.
//
//   POST /api/myrmidon/bots/me/disk-report   C4 write: the bot's disk snapshot
//   GET  /api/myrmidon/bot-disk/reports      C4 read: last report per bot
//   GET  /api/myrmidon/bot-disk/physical     C5 read: the bot partition itself
//
// WRITE — who may report for whom. The key is the bot's own agent API key and
// nothing else: the actor must be an agent, its agent row must carry a bot
// container card (hermes_gateway + container.enabled + a compilable container
// block), and the bot key is *derived* from the agent id (`botKeyForAgent`).
// `body.botKey` is only compared against that derived key — it never decides
// where the report is filed. So a bot cannot write into another bot's slot, and
// a board session cannot write at all.
//
// SIZE — 1 MiB (C4). The declared Content-Length is refused before the body is
// read, and the raw bytes app.ts already captures for every JSON request
// (`captureRawBody`, body-limits.ts) are measured after parsing, so a chunked
// request without a length cannot slip past either. Both answer 413, and the
// previous report survives.
//
// VALIDATION — the shared zod schema, nothing hand-rolled: a body that is not a
// report is 400 and the previous report stays. A report is a snapshot, so more
// than WS_DISK_REPORT_MAX_ACTIONS actions is a contract violation (400), never a
// silent truncation.
//
// READ — both reads are board-facing (assertBoardOrgAccess), as the panel is: a
// bot key sees its own report through no route of its own, so two bots cannot
// read each other's numbers. The partition is measured on the board host with
// the host-disk statfs reader, so the panel shows the fill level operators care
// about without walking any bot volume (the C5 per-project rows come from
// dockergate's prjquota view — part A14 — and are empty here until the board
// reads that route; `quotaEnabled` says so).

import { Router, type NextFunction, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import {
  WS_DISK_REPORT_MAX_ACTIONS,
  WS_DISK_REPORT_MAX_BODY_BYTES,
  wsDiskReportSchema,
  type WsDiskApiResponse,
  type WsDiskReport,
  type WsDiskReportResponse,
} from "@paperclipai/shared";
import { HttpError, badRequest, forbidden, payloadTooLarge } from "../../errors.js";
import { assertAuthenticated, assertBoardOrgAccess } from "../../routes/authz.js";
import { botKeyForAgent, readBotContainerAgentConfig } from "./agent-config.js";
import { BOT_VOLUME_ROOT_ENV } from "./bot-quota.js";
import { readBotDiskReports, storeBotDiskReport } from "./bot-disk-report-store.js";
import { hostDiskDataRoot, readHostDiskUsage } from "../host-disk/index.js";

/** Pacing the board asks of the next botd pass (contract C4). */
export const BOT_DISK_NEXT_REPORT_SEC = 300;

/** Message of the 413 answer; the same text for both size checks. */
export const BOT_DISK_REPORT_TOO_LARGE = "Disk report body is too large";

/** Message of the 400 answer when the body is not a report. */
export const BOT_DISK_REPORT_INVALID = "Invalid disk report";

/** Message of the 403 answer when the key is not a bot container's own key. */
export const BOT_DISK_REPORT_NOT_A_BOT = "This API key does not belong to a bot container";

/** The partition a bot volume lives on, as measured on the board host. */
export interface BotDiskPartitionMeasurement {
  mount: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
}

/** One row of GET /api/myrmidon/bot-disk/reports. */
export interface BotDiskReportListItem {
  botKey: string;
  imageGeneration: string;
  /** When the board accepted the report. */
  receivedAt: string;
  /** The bot's own `at`. */
  reportedAt: string;
  /** The report as validated (contract C4). */
  report: WsDiskReport;
}

export interface BotDiskReportAgent {
  id: string;
  companyId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}

export interface BotDiskReportRoutesDeps {
  /** The agent behind an agent API key: the card read, without the runtime. */
  getAgent(agentId: string): Promise<BotDiskReportAgent | null>;
  /** Directory whose filesystem is the bot partition, or null when unset. */
  botVolumeRoot(): string | null;
  /** Usage of that directory (host-disk measure.ts). */
  measureUsage(directory: string): Promise<BotDiskPartitionMeasurement | null>;
}

/** ISO second, the shape the contract fixtures use (`2026-10-06T14:05:00Z`). */
function isoSecond(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function botDiskReportRoutes(deps: BotDiskReportRoutesDeps) {
  const router = Router();

  /**
   * Refuse a declared length over the cap before the body is read. The parser
   * has already buffered it (the global JSON limit is far above 1 MiB), but the
   * answer is the contract's, and the raw-byte check below covers a request
   * that declares no length at all.
   */
  function capDeclaredBody(req: Request, res: Response, next: NextFunction) {
    const declared = req.headers["content-length"];
    if (typeof declared === "string" && /^\d+$/.test(declared)) {
      const bytes = Number(declared);
      if (bytes > WS_DISK_REPORT_MAX_BODY_BYTES) {
        next(
          payloadTooLarge(BOT_DISK_REPORT_TOO_LARGE, {
            limitBytes: WS_DISK_REPORT_MAX_BODY_BYTES,
            contentLengthBytes: bytes,
          }),
        );
        return;
      }
    }
    next();
  }

  router.post("/myrmidon/bots/me/disk-report", capDeclaredBody, async (req, res, next) => {
    try {
      assertAuthenticated(req);
      if (req.actor.type !== "agent") throw forbidden(BOT_DISK_REPORT_NOT_A_BOT);

      // Exact bytes as they arrived. app.ts captures the raw body for every
      // JSON request; the fallback covers a harness (or a future parser) that
      // does not, and stays honest about what it measured.
      const raw = (req as Request & { rawBody?: Buffer }).rawBody;
      const bytes = raw ? raw.length : Buffer.byteLength(JSON.stringify(req.body ?? null), "utf8");
      if (bytes > WS_DISK_REPORT_MAX_BODY_BYTES) {
        throw payloadTooLarge(BOT_DISK_REPORT_TOO_LARGE, {
          limitBytes: WS_DISK_REPORT_MAX_BODY_BYTES,
          bodyBytes: bytes,
        });
      }

      const parsed = wsDiskReportSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(BOT_DISK_REPORT_INVALID, parsed.error.issues);
      const report = parsed.data;

      if (report.actions.length > WS_DISK_REPORT_MAX_ACTIONS) {
        throw badRequest(BOT_DISK_REPORT_INVALID, {
          reason: "too many actions",
          limit: WS_DISK_REPORT_MAX_ACTIONS,
          actions: report.actions.length,
        });
      }

      // The key the report is filed under: from the agent behind the API key,
      // never from the body.
      const agentId = req.actor.agentId;
      const agent = agentId ? await deps.getAgent(agentId) : null;
      const card = agent ? readBotContainerAgentConfig(agent.adapterType, agent.adapterConfig) : null;
      const botKey = agent && card?.ok ? botKeyForAgent(agent.id) : null;
      if (!botKey) throw forbidden(BOT_DISK_REPORT_NOT_A_BOT);
      if (report.botKey !== botKey) {
        throw forbidden("A bot reports only for its own bot key", { reportedBotKey: report.botKey });
      }

      storeBotDiskReport(botKey, report);
      const body: WsDiskReportResponse = { ok: true, nextReportSec: BOT_DISK_NEXT_REPORT_SEC };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.get("/myrmidon/bot-disk/reports", async (req, res) => {
    assertBoardOrgAccess(req);
    const reports: BotDiskReportListItem[] = readBotDiskReports().map((record) => ({
      botKey: record.botKey,
      imageGeneration: record.report.imageGeneration,
      receivedAt: isoSecond(new Date(record.receivedAtMs)),
      reportedAt: isoSecond(new Date(record.reportedAtMs)),
      report: record.report,
    }));
    res.json({ reports });
  });

  router.get("/myrmidon/bot-disk/physical", async (req, res) => {
    assertBoardOrgAccess(req);
    const directory = deps.botVolumeRoot();
    const usage = directory ? await deps.measureUsage(directory) : null;
    if (!usage) {
      throw new HttpError(503, "Bot partition is not measurable from the board", {
        directory: directory ?? null,
        hint: `set ${BOT_VOLUME_ROOT_ENV} to the directory whose filesystem is the bot partition`,
      });
    }
    const body: WsDiskApiResponse = {
      partition: {
        mount: usage.mount,
        totalBytes: usage.totalBytes,
        usedBytes: usage.usedBytes,
        freeBytes: usage.freeBytes,
        usedPercent: usage.usedPercent,
      },
      // The per-project rows of C5 come from dockergate's prjquota view (A14);
      // the board does not read that route yet, so it reports the partition
      // alone instead of inventing rows.
      projects: [],
      other: { usedBytes: usage.usedBytes },
      quotaEnabled: false,
      at: isoSecond(new Date()),
    };
    res.json(body);
  });

  return router;
}

/** Router for app.ts: the ingest route plus the two panel reads. */
export function myrmidonBotDiskReportRoutes(db: Db) {
  return botDiskReportRoutes({
    getAgent: async (agentId) => {
      // A malformed id (or one that cannot be a bot key) is "no such agent".
      if (botKeyForAgent(agentId) === null) return null;
      return db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          adapterType: agents.adapterType,
          adapterConfig: agents.adapterConfig,
        })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
    },
    botVolumeRoot: () => {
      const fromEnv = process.env[BOT_VOLUME_ROOT_ENV]?.trim();
      if (fromEnv) return fromEnv;
      return hostDiskDataRoot(process.env);
    },
    measureUsage: (directory) => readHostDiskUsage(directory),
  });
}