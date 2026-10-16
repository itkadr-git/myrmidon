// server/src/myrmidon/bot-containers/fleet-move-service.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T5): bot migration state machine between fleet sites.
//
// State machine (§3.4):
//   stop -> snapshot -> restore -> host -> reconcile -> apiBaseUrl -> quarantine -> done
//
// Zero data loss:
// - Datadir moves intact (hermes sqlite, workspace, scratch) via tar.zst stream.
// - Reconciler runs on target host with the same profile hashes.
// - No duplicate runs: maintenance window holds runs during the move,
//   runs only resume after card-sync writes the new apiBaseUrl.
// - Idempotent: stores phase CAS in myrmidon_fleet_moves; resumption continues
//   from the last completed phase.

import type { Readable } from "node:stream";
import type { BotContainerDriver, BotContainerSpec } from "./driver.js";
import type { CompiledProfile } from "./types.js";
import { fleetGatewayApiBaseUrl } from "./fleetd-placement.js";

export type MovePhase =
  | "init"
  | "stop"
  | "snapshot"
  | "restore"
  | "host"
  | "reconcile"
  | "apiBaseUrl"
  | "quarantine"
  | "done"
  | "failed";

export interface MovePhaseLogEntry {
  phase: MovePhase;
  at: string;
  details?: string;
  error?: string;
}

export interface FleetMoveRecord {
  id: string;
  companyId: string;
  botKey: string;
  srcSite: string;
  dstSite: string;
  phase: MovePhase;
  phaseLog: MovePhaseLogEntry[];
  startedAt: Date;
  completedAt?: Date | null;
  leaseExpires?: Date | null;
  error?: string | null;
}

export interface SiteAgentClient {
  snapshot(botKey: string): Promise<Readable>;
  restore(botKey: string, stream: Readable): Promise<void>;
  quarantine(botKey: string): Promise<void>;
}

export interface MaintenanceController {
  enter(botKey: string): Promise<void>;
  exit(botKey: string): Promise<void>;
}

export interface FleetMoveServiceDeps {
  getMove(moveId: string): Promise<FleetMoveRecord | null>;
  getLatestMoveForBot(companyId: string, botKey: string): Promise<FleetMoveRecord | null>;
  createMove(params: {
    companyId: string;
    botKey: string;
    srcSite: string;
    dstSite: string;
  }): Promise<FleetMoveRecord>;
  updateMove(
    moveId: string,
    update: {
      phase: MovePhase;
      details?: string;
      error?: string | null;
      completedAt?: Date | null;
      leaseExpires?: Date | null;
    },
  ): Promise<FleetMoveRecord>;

  getDriverForSite(siteName: string): Promise<BotContainerDriver>;
  getSiteAgentClient(siteName: string): Promise<SiteAgentClient>;
  getSiteUrl(siteName: string): Promise<string>;

  getAgentCard(botKey: string): Promise<{
    agentId: string;
    adapterConfig: Record<string, unknown>;
  } | null>;
  updateAgentCard(agentId: string, adapterConfig: Record<string, unknown>): Promise<void>;

  getBotSpec(botKey: string): Promise<BotContainerSpec>;
  getCompiledProfile(botKey: string): Promise<CompiledProfile>;

  maintenance?: MaintenanceController;
  log?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
}

export class FleetMoveService {
  constructor(private readonly deps: FleetMoveServiceDeps) {}

  /** Initiates or resumes a bot move to dstSite. */
  async startMove(params: {
    companyId: string;
    botKey: string;
    dstSite: string;
  }): Promise<FleetMoveRecord> {
    const card = await this.deps.getAgentCard(params.botKey);
    if (!card) throw new Error(`Bot "${params.botKey}" not found`);

    const container = typeof card.adapterConfig.container === "object" && card.adapterConfig.container !== null
      ? (card.adapterConfig.container as Record<string, unknown>)
      : {};

    const srcSite = (typeof container.host === "string" && container.host.trim()) ? container.host.trim() : "local";
    if (srcSite === params.dstSite) {
      throw new Error(`Bot "${params.botKey}" is already on site "${params.dstSite}"`);
    }

    // Check for existing pending/running move
    const existing = await this.deps.getLatestMoveForBot(params.companyId, params.botKey);
    if (existing && existing.phase !== "done" && existing.phase !== "failed") {
      this.deps.log?.info({ moveId: existing.id, botKey: params.botKey, phase: existing.phase }, "Resuming existing move");
      return this.executeMove(existing.id);
    }

    const record = await this.deps.createMove({
      companyId: params.companyId,
      botKey: params.botKey,
      srcSite,
      dstSite: params.dstSite,
    });

    return this.executeMove(record.id);
  }

  /** Advances the move state machine until completion or error. */
  async executeMove(moveId: string): Promise<FleetMoveRecord> {
    let move = await this.deps.getMove(moveId);
    if (!move) throw new Error(`Move record "${moveId}" not found`);

    const { botKey, srcSite, dstSite } = move;

    try {
      // Phase 1: STOP
      if (move.phase === "init" || move.phase === "stop") {
        this.deps.log?.info({ moveId, botKey, phase: "stop" }, "Phase: stop");
        if (this.deps.maintenance) {
          await this.deps.maintenance.enter(botKey);
        }

        const srcDriver = await this.deps.getDriverForSite(srcSite);
        await srcDriver.stop(botKey);

        move = await this.deps.updateMove(moveId, {
          phase: "stop",
          details: `Stopped container on "${srcSite}" and entered maintenance window`,
        });
      }

      // Phase 2: SNAPSHOT
      let snapshotStream: Readable | null = null;
      if (move.phase === "stop" || move.phase === "snapshot") {
        this.deps.log?.info({ moveId, botKey, phase: "snapshot" }, "Phase: snapshot");
        const srcClient = await this.deps.getSiteAgentClient(srcSite);
        snapshotStream = await srcClient.snapshot(botKey);

        move = await this.deps.updateMove(moveId, {
          phase: "snapshot",
          details: `Captured snapshot tar.zst from "${srcSite}"`,
        });
      }

      // Phase 3: RESTORE
      if (move.phase === "snapshot" || move.phase === "restore") {
        this.deps.log?.info({ moveId, botKey, phase: "restore" }, "Phase: restore");
        if (!snapshotStream) {
          const srcClient = await this.deps.getSiteAgentClient(srcSite);
          snapshotStream = await srcClient.snapshot(botKey);
        }

        const dstClient = await this.deps.getSiteAgentClient(dstSite);
        await dstClient.restore(botKey, snapshotStream);

        move = await this.deps.updateMove(moveId, {
          phase: "restore",
          details: `Restored snapshot tar.zst onto "${dstSite}"`,
        });
      }

      // Phase 4: HOST (Update card container.host)
      if (move.phase === "restore" || move.phase === "host") {
        this.deps.log?.info({ moveId, botKey, phase: "host" }, "Phase: host");
        const card = await this.deps.getAgentCard(botKey);
        if (!card) throw new Error(`Card for bot "${botKey}" disappeared`);

        const container = typeof card.adapterConfig.container === "object" && card.adapterConfig.container !== null
          ? { ...(card.adapterConfig.container as Record<string, unknown>) }
          : {};

        container.host = dstSite;
        await this.deps.updateAgentCard(card.agentId, {
          ...card.adapterConfig,
          container,
        });

        move = await this.deps.updateMove(moveId, {
          phase: "host",
          details: `Updated container.host to "${dstSite}" in agent card`,
        });
      }

      // Phase 5: RECONCILE (Create, writeProfile, start on target)
      if (move.phase === "host" || move.phase === "reconcile") {
        this.deps.log?.info({ moveId, botKey, phase: "reconcile" }, "Phase: reconcile");
        const dstDriver = await this.deps.getDriverForSite(dstSite);
        const spec = await this.deps.getBotSpec(botKey);
        const profile = await this.deps.getCompiledProfile(botKey);

        const status = await dstDriver.status(botKey);
        if (status.state === "missing") {
          await dstDriver.create(spec);
        }
        await dstDriver.writeProfile(botKey, profile);
        await dstDriver.start(botKey);

        move = await this.deps.updateMove(moveId, {
          phase: "reconcile",
          details: `Reconciled and started container on "${dstSite}"`,
        });
      }

      // Phase 6: API_BASE_URL (card sync + maintenance exit)
      if (move.phase === "reconcile" || move.phase === "apiBaseUrl") {
        this.deps.log?.info({ moveId, botKey, phase: "apiBaseUrl" }, "Phase: apiBaseUrl");
        const dstDriver = await this.deps.getDriverForSite(dstSite);
        const dstStatus = await dstDriver.status(botKey);

        let newApiBaseUrl: string;
        if (dstSite === "local") {
          newApiBaseUrl = `http://myrmidon-bot-${botKey}:8642`;
        } else {
          const dstUrl = await this.deps.getSiteUrl(dstSite);
          const port = dstStatus.gatewayPort ?? 8642;
          newApiBaseUrl = fleetGatewayApiBaseUrl(dstUrl, port);
        }

        const card = await this.deps.getAgentCard(botKey);
        if (card) {
          await this.deps.updateAgentCard(card.agentId, {
            ...card.adapterConfig,
            apiBaseUrl: newApiBaseUrl,
          });
        }

        if (this.deps.maintenance) {
          await this.deps.maintenance.exit(botKey);
        }

        move = await this.deps.updateMove(moveId, {
          phase: "apiBaseUrl",
          details: `Updated apiBaseUrl to "${newApiBaseUrl}" and exited maintenance window`,
        });
      }

      // Phase 7: QUARANTINE (Source datadir quarantine)
      if (move.phase === "apiBaseUrl" || move.phase === "quarantine") {
        this.deps.log?.info({ moveId, botKey, phase: "quarantine" }, "Phase: quarantine");
        if (srcSite !== "local") {
          try {
            const srcClient = await this.deps.getSiteAgentClient(srcSite);
            await srcClient.quarantine(botKey);
          } catch (err) {
            this.deps.log?.warn({ moveId, botKey, srcSite, err }, "Source datadir quarantine warning");
          }
        }

        move = await this.deps.updateMove(moveId, {
          phase: "done",
          completedAt: new Date(),
          details: `Move complete from "${srcSite}" to "${dstSite}"`,
        });
      }

      return move;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.deps.log?.error({ moveId, botKey, phase: move.phase, err }, "Fleet move failed");

      return this.deps.updateMove(moveId, {
        phase: "failed",
        error: errorMsg,
        details: `Failed during phase "${move.phase}": ${errorMsg}`,
      });
    }
  }
}
