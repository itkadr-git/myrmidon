// server/src/myrmidon/bot-containers/fleet-move-service.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T5): bot migration state machine between fleet sites.
//
// State machine (§3.4):
//   stop -> snapshot -> restore -> host -> reconcile -> apiBaseUrl -> quarantine -> done
//
// Zero data loss:
// - Datadir moves intact (hermes sqlite, workspace, scratch) via a tar stream in a
//   zstd frame (raw blocks, not compressed yet). The site-agent ends every snapshot
//   with a manifest (entry count, bytes, SHA-256) that restore verifies; a snapshot
//   that broke off is an error on both sides and nothing is put in place.
// - Reconciler runs on target host with the same profile hashes.
// - No duplicate runs: the agent's maintenance window (R3) holds runs during the
//   move and is closed only after the card carries the new apiBaseUrl; the whole
//   move runs under the per-bot lock, so the reconcile sweep cannot restart the
//   stopped container half way.
// - Failure rolls back: the card goes back to the source site and the source
//   container is started again (the source datadir is untouched until the final
//   quarantine), then the window is closed. A rollback that itself fails is said
//   so in the phase log.
// - Idempotent: stores the last completed phase in myrmidon_fleet_moves; resuming an
//   unfinished move continues after that phase. A failed move is over: a new one
//   starts from the beginning.

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

/** Where the datadir of a move comes from: the live source site, or the last replica of a lost one. */
export type MoveSource = "live" | "replica";

/** The last replica of a bot's datadir (myrmidon/bot-containers/fleet-replica-store.ts). */
export interface ReplicaSnapshot {
  stream: Readable;
  /** When the replica was taken: the data of the restored bot is as old as this. */
  capturedAt: Date;
}

export interface FleetMoveRecord {
  id: string;
  companyId: string;
  botKey: string;
  srcSite: string;
  dstSite: string;
  source?: MoveSource;
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

/** The agent's maintenance window (R3) for the duration of a move. `enter` resolves once
 *  the bot has no run in flight and rejects when it cannot get there. */
export interface MaintenanceController {
  enter(botKey: string): Promise<void>;
  exit(botKey: string): Promise<void>;
}

export interface MoveLock {
  run<T>(botKey: string, fn: () => Promise<T>): Promise<T>;
}

export interface FleetMoveServiceDeps {
  getMove(moveId: string): Promise<FleetMoveRecord | null>;
  getLatestMoveForBot(companyId: string, botKey: string): Promise<FleetMoveRecord | null>;
  /** Claims the bot's single unfinished-move slot; throws FleetMoveClaimConflict when it is taken. */
  createMove(params: {
    companyId: string;
    botKey: string;
    srcSite: string;
    dstSite: string;
    source?: MoveSource;
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
  /** The last replica of the bot on `site`, or null. Required for a move with source "replica". */
  openReplica?(site: string, botKey: string, companyId: string): Promise<ReplicaSnapshot | null>;

  /** Sites are resolved in the company that owns the move (its secrets, its site registry). */
  getDriverForSite(siteName: string, companyId: string): Promise<BotContainerDriver>;
  getSiteAgentClient(siteName: string, companyId: string): Promise<SiteAgentClient>;
  getSiteUrl(siteName: string, companyId: string): Promise<string>;

  getAgentCard(botKey: string): Promise<{
    agentId: string;
    adapterConfig: Record<string, unknown>;
  } | null>;
  updateAgentCard(agentId: string, adapterConfig: Record<string, unknown>): Promise<void>;

  getBotSpec(botKey: string): Promise<BotContainerSpec>;
  getCompiledProfile(botKey: string): Promise<CompiledProfile>;

  /** Required: a move without the window can run the bot twice. */
  maintenance: MaintenanceController;
  /** The per-bot lock shared with the reconcile sweep. */
  lock?: MoveLock;
  log?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
}

const PHASE_ORDER: readonly MovePhase[] = [
  "init",
  "stop",
  "snapshot",
  "restore",
  "host",
  "reconcile",
  "apiBaseUrl",
  "quarantine",
  "done",
];

/** True when `move` already completed `phase` (the stored phase is the last completed one). */
function completed(move: FleetMoveRecord, phase: MovePhase): boolean {
  const have = PHASE_ORDER.indexOf(move.phase);
  return have >= PHASE_ORDER.indexOf(phase);
}

/** A move that cannot start for a reason the caller can act on (the routes map `kind` to a status). */
export class FleetMoveError extends Error {
  constructor(
    message: string,
    readonly kind: "not_found" | "conflict",
  ) {
    super(message);
    this.name = "FleetMoveError";
  }
}

/** The bot's slot for an unfinished move is taken (the store's atomic claim lost the race). */
export class FleetMoveClaimConflict extends Error {
  constructor(botKey: string) {
    super(`Bot "${botKey}" already has an unfinished move`);
    this.name = "FleetMoveClaimConflict";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The card of a bot on `site` (the local driver has no host name on the card). */
function withCardHost(adapterConfig: Record<string, unknown>, site: string): Record<string, unknown> {
  const container = isRecord(adapterConfig.container) ? { ...adapterConfig.container } : {};
  if (site === "local") delete container.host;
  else container.host = site;
  return { ...adapterConfig, container };
}

export class FleetMoveService {
  constructor(private readonly deps: FleetMoveServiceDeps) {}

  /** The newest move of a bot, for the status route. */
  getLatestMove(companyId: string, botKey: string): Promise<FleetMoveRecord | null> {
    return this.deps.getLatestMoveForBot(companyId, botKey);
  }

  /** Initiates or resumes a bot move to dstSite. Moves of one bot never overlap. */
  async startMove(params: {
    companyId: string;
    botKey: string;
    dstSite: string;
    source?: MoveSource;
  }): Promise<FleetMoveRecord> {
    const run = () => this.startMoveLocked(params);
    return this.deps.lock ? this.deps.lock.run(params.botKey, run) : run();
  }

  private async startMoveLocked(params: {
    companyId: string;
    botKey: string;
    dstSite: string;
    source?: MoveSource;
  }): Promise<FleetMoveRecord> {
    const card = await this.deps.getAgentCard(params.botKey);
    if (!card) throw new FleetMoveError(`Bot "${params.botKey}" not found`, "not_found");

    // An unfinished move is resumed before anything else is decided: the card may already
    // name the destination (host phase done), and the source is the one the move recorded.
    const existing = await this.deps.getLatestMoveForBot(params.companyId, params.botKey);
    if (existing && existing.phase !== "done" && existing.phase !== "failed") {
      if (existing.dstSite !== params.dstSite) {
        throw new FleetMoveError(
          `Bot "${params.botKey}" has an unfinished move to "${existing.dstSite}"; finish it before moving to "${params.dstSite}"`,
          "conflict",
        );
      }
      this.deps.log?.info({ moveId: existing.id, botKey: params.botKey, phase: existing.phase }, "Resuming existing move");
      return this.executeMove(existing.id);
    }

    const container = isRecord(card.adapterConfig.container) ? card.adapterConfig.container : {};
    const srcSite = typeof container.host === "string" && container.host.trim() ? container.host.trim() : "local";
    if (srcSite === params.dstSite) {
      throw new FleetMoveError(`Bot "${params.botKey}" is already on site "${params.dstSite}"`, "conflict");
    }

    // The claim is atomic in the store (one unfinished move per bot): the per-bot lock above is
    // in-process only, so a second board process loses here, not in a read-then-insert gap.
    let record: FleetMoveRecord;
    try {
      record = await this.deps.createMove({
        companyId: params.companyId,
        botKey: params.botKey,
        srcSite,
        dstSite: params.dstSite,
        source: params.source ?? "live",
      });
    } catch (err) {
      if (err instanceof FleetMoveClaimConflict) {
        throw new FleetMoveError(`Bot "${params.botKey}" already has an unfinished move`, "conflict");
      }
      throw err;
    }

    return this.executeMove(record.id);
  }

  private async openReplicaOrThrow(srcSite: string, botKey: string, companyId: string): Promise<ReplicaSnapshot> {
    const replica = await this.deps.openReplica?.(srcSite, botKey, companyId);
    if (!replica) throw new Error(`No replica of "${botKey}" from site "${srcSite}" to restore`);
    return replica;
  }

  /** The gateway URL the card must carry for a bot running on `site`. */
  private async apiBaseUrlFor(site: string, botKey: string, companyId: string): Promise<string> {
    if (site === "local") return `http://myrmidon-bot-${botKey}:8642`;
    const driver = await this.deps.getDriverForSite(site, companyId);
    const status = await driver.status(botKey);
    // A missing port throws inside fleetGatewayApiBaseUrl: never a guessed default.
    return fleetGatewayApiBaseUrl(await this.deps.getSiteUrl(site, companyId), status.gatewayPort);
  }

  /** Advances the move state machine until completion or error. */
  async executeMove(moveId: string): Promise<FleetMoveRecord> {
    let move = await this.deps.getMove(moveId);
    if (!move) throw new Error(`Move record "${moveId}" not found`);
    if (move.phase === "done" || move.phase === "failed") return move;

    const { botKey, srcSite, dstSite, companyId } = move;
    // A replica move never talks to the source site: it is lost.
    const fromReplica = move.source === "replica";
    const log = this.deps.log;
    let snapshotStream: Readable | null = null;
    // The agent's window is open from the end of the stop phase's enter(); nothing is
    // to be rolled back before that.
    let windowOpened = completed(move, "stop");
    // Once the source datadir is set aside the move cannot be undone.
    let pastPointOfNoReturn = false;

    try {
      // Phase 1: STOP — maintenance window, then stop the source container.
      if (!completed(move, "stop")) {
        log?.info({ moveId, botKey, phase: "stop" }, "Phase: stop");
        await this.deps.maintenance.enter(botKey);
        windowOpened = true;

        if (!fromReplica) {
          const srcDriver = await this.deps.getDriverForSite(srcSite, companyId);
          await srcDriver.stop(botKey);
          const stopped = await srcDriver.status(botKey);
          if (stopped.state === "running" || stopped.state === "unhealthy") {
            throw new Error(`Container of "${botKey}" is still ${stopped.state} on "${srcSite}" after stop`);
          }
        }

        move = await this.deps.updateMove(moveId, {
          phase: "stop",
          details: fromReplica
            ? `Entered maintenance window; source site "${srcSite}" is lost and was not contacted`
            : `Stopped container on "${srcSite}" and entered maintenance window`,
        });
      }

      // Phase 2: SNAPSHOT — open the snapshot stream of the stopped datadir.
      if (!completed(move, "snapshot")) {
        log?.info({ moveId, botKey, phase: "snapshot" }, "Phase: snapshot");
        let snapshotNote: string;
        if (fromReplica) {
          const replica = await this.openReplicaOrThrow(srcSite, botKey, companyId);
          snapshotStream = replica.stream;
          snapshotNote = `Opened the replica of "${srcSite}" taken at ${replica.capturedAt.toISOString()}; data newer than that is lost`;
        } else {
          const srcClient = await this.deps.getSiteAgentClient(srcSite, companyId);
          snapshotStream = await srcClient.snapshot(botKey);
          snapshotNote = `Opened snapshot stream (tar in zstd, verified by manifest) from "${srcSite}"`;
        }

        move = await this.deps.updateMove(moveId, { phase: "snapshot", details: snapshotNote });
      }

      // Phase 3: RESTORE — the destination verifies the manifest before it puts the datadir in place.
      if (!completed(move, "restore")) {
        log?.info({ moveId, botKey, phase: "restore" }, "Phase: restore");
        if (!snapshotStream) {
          // Resumed after a restart: the source is stopped and untouched, so a new snapshot is the same data.
          snapshotStream = fromReplica
            ? (await this.openReplicaOrThrow(srcSite, botKey, companyId)).stream
            : await (await this.deps.getSiteAgentClient(srcSite, companyId)).snapshot(botKey);
        }

        const dstClient = await this.deps.getSiteAgentClient(dstSite, companyId);
        await dstClient.restore(botKey, snapshotStream);
        snapshotStream = null;

        move = await this.deps.updateMove(moveId, {
          phase: "restore",
          details: `Restored and verified snapshot on "${dstSite}"`,
        });
      }

      // Phase 4: HOST — the card names the destination (the profile is compiled from the card).
      if (!completed(move, "host")) {
        log?.info({ moveId, botKey, phase: "host" }, "Phase: host");
        const card = await this.deps.getAgentCard(botKey);
        if (!card) throw new Error(`Card for bot "${botKey}" disappeared`);
        await this.deps.updateAgentCard(card.agentId, withCardHost(card.adapterConfig, dstSite));

        move = await this.deps.updateMove(moveId, {
          phase: "host",
          details: `Updated container.host to "${dstSite}" in agent card`,
        });
      }

      // Phase 5: RECONCILE — create, write the profile, start on the destination, and check it runs.
      if (!completed(move, "reconcile")) {
        log?.info({ moveId, botKey, phase: "reconcile" }, "Phase: reconcile");
        const dstDriver = await this.deps.getDriverForSite(dstSite, companyId);
        const spec = await this.deps.getBotSpec(botKey);
        const profile = await this.deps.getCompiledProfile(botKey);

        const status = await dstDriver.status(botKey);
        if (status.state === "missing") {
          await dstDriver.create(spec);
        }
        await dstDriver.writeProfile(botKey, profile);
        await dstDriver.start(botKey);
        const started = await dstDriver.status(botKey);
        if (started.state !== "running") {
          throw new Error(`Container of "${botKey}" is ${started.state} on "${dstSite}" after start`);
        }

        move = await this.deps.updateMove(moveId, {
          phase: "reconcile",
          details: `Reconciled and started container on "${dstSite}"`,
        });
      }

      // Phase 6: API_BASE_URL — the card points at the destination. The window stays open until the final step.
      if (!completed(move, "apiBaseUrl")) {
        log?.info({ moveId, botKey, phase: "apiBaseUrl" }, "Phase: apiBaseUrl");
        const newApiBaseUrl = await this.apiBaseUrlFor(dstSite, botKey, companyId);

        const card = await this.deps.getAgentCard(botKey);
        if (!card) throw new Error(`Card for bot "${botKey}" disappeared`);
        await this.deps.updateAgentCard(card.agentId, { ...card.adapterConfig, apiBaseUrl: newApiBaseUrl });

        move = await this.deps.updateMove(moveId, {
          phase: "apiBaseUrl",
          details: `Updated apiBaseUrl to "${newApiBaseUrl}"`,
        });
      }

      // Phase 7: the window closes (runs resume against the destination), then the source
      // datadir is set aside (kept, not deleted). An exit that fails still rolls back.
      log?.info({ moveId, botKey, phase: "quarantine" }, "Phase: quarantine");
      await this.deps.maintenance.exit(botKey);
      pastPointOfNoReturn = true;
      let quarantineNote = "";
      if (fromReplica) {
        quarantineNote = `; source site "${srcSite}" was not contacted, its copy is fenced when it returns`;
      } else if (srcSite !== "local") {
        try {
          const srcClient = await this.deps.getSiteAgentClient(srcSite, companyId);
          await srcClient.quarantine(botKey);
        } catch (err) {
          quarantineNote = `; source datadir NOT quarantined: ${errorText(err)}`;
          log?.warn({ moveId, botKey, srcSite, err }, "Source datadir quarantine warning");
        }
      }

      return await this.deps.updateMove(moveId, {
        phase: "done",
        completedAt: new Date(),
        details: `Move complete from "${srcSite}" to "${dstSite}"; exited maintenance window${quarantineNote}`,
      });
    } catch (err) {
      const errorMsg = errorText(err);
      log?.error({ moveId, botKey, phase: move.phase, err }, "Fleet move failed");
      // The destination already runs the bot and the window is closed: only the record is
      // missing. Rolling back now would start a second copy of the bot.
      if (pastPointOfNoReturn) throw err;

      const rollback = await this.rollback(move, srcSite, dstSite, windowOpened, fromReplica);
      return this.deps.updateMove(moveId, {
        phase: "failed",
        error: rollback.ok ? errorMsg : `${errorMsg}; ROLLBACK INCOMPLETE: ${rollback.problems.join("; ")}`,
        details: `Failed after phase "${move.phase}": ${errorMsg}. ${rollback.summary}`,
      });
    }
  }

  /**
   * Puts the bot back where it was: the source datadir is untouched before the final
   * quarantine, so the card returns to the source, the source container starts, and the
   * window closes. Each step is tried even when an earlier one failed.
   */
  private async rollback(
    move: FleetMoveRecord,
    srcSite: string,
    dstSite: string,
    windowOpened: boolean,
    fromReplica = false,
  ): Promise<{ ok: boolean; summary: string; problems: string[] }> {
    const { botKey, companyId } = move;
    if (!windowOpened) {
      // Nothing was stopped: the window was never entered.
      return { ok: true, problems: [], summary: "Nothing to roll back: the source container was not touched." };
    }
    const problems: string[] = [];
    const done: string[] = [];
    const attempt = async (what: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
        done.push(what);
      } catch (err) {
        problems.push(`${what}: ${errorText(err)}`);
        this.deps.log?.error({ moveId: move.id, botKey, err }, `Fleet move rollback step failed: ${what}`);
      }
    };

    if (completed(move, "host")) {
      await attempt(`stopped the destination container on "${dstSite}"`, async () => {
        const dstDriver = await this.deps.getDriverForSite(dstSite, companyId);
        await dstDriver.stop(botKey);
      });
      await attempt(`returned the card to "${srcSite}"`, async () => {
        const card = await this.deps.getAgentCard(botKey);
        if (!card) throw new Error("card not found");
        const back = withCardHost(card.adapterConfig, srcSite);
        const apiBaseUrl = await this.apiBaseUrlFor(srcSite, botKey, move.companyId).catch(() => null);
        await this.deps.updateAgentCard(card.agentId, apiBaseUrl ? { ...back, apiBaseUrl } : back);
      });
    }
    // A replica move never stopped the source (it is lost), so there is nothing to start there.
    if (!fromReplica) {
      await attempt(`started the container on "${srcSite}"`, async () => {
        const srcDriver = await this.deps.getDriverForSite(srcSite, companyId);
        await srcDriver.start(botKey);
        const status = await srcDriver.status(botKey);
        if (status.state !== "running") throw new Error(`container is ${status.state} after start`);
      });
    }
    await attempt("exited the maintenance window", () => this.deps.maintenance.exit(botKey));

    const ok = problems.length === 0;
    return {
      ok,
      problems,
      summary: ok
        ? `Rolled back: ${done.join(", ")}.`
        : `Rollback incomplete (${problems.length} step(s) failed); done: ${done.join(", ") || "nothing"}. Check the bot by hand.`,
    };
  }
}
