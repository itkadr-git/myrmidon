// server/src/myrmidon/bot-containers/fleet-replica-store.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T4): the board-side store of datadir replicas (remote-sites-v2 4.4).
//
// A site that dies takes its datadirs with it, so the board keeps the last snapshot of every bot
// of a remote site on its own disk: <root>/<site>/<botKey>/latest.tar.zst (the previous one stays
// as previous.tar.zst). The snapshot is the site-agent's own stream (tar in a zstd frame ending
// with a manifest that restore verifies); it is kept as one file and never unpacked on the board.
//
// A replica is written to a temporary file in the same directory and renamed over `latest` only
// after the whole stream arrived, so a stream that broke off never replaces a good replica.
//
// myrmidon(fleet-site audit): the stream is not stored as it came. The secret files of the bot's
// profile (hermes/.env, hermes/config.yaml: profile-files.ts) are filtered out on the way in and the
// archive's manifest is rewritten to match (fleet-replica-filter.ts); the apply that follows every
// restore writes them again. A stream the filter cannot read and check completely is refused like
// one that broke off: the previous replica stays.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { ReplicaSnapshot } from "./fleet-move-service.js";
import { filterReplicaSnapshot, type ReplicaFilterReport } from "./fleet-replica-filter.js";
import { PROFILE_SECRET_FILE_PATHS } from "./profile-files.js";

export const FLEET_REPLICA_DIR_ENV = "MYRMIDON_FLEET_REPLICA_DIR";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface FleetReplicaStore {
  /** When the last replica of the bot on `site` was taken, or null when there is none. */
  capturedAt(site: string, botKey: string): Promise<Date | null>;
  open(site: string, botKey: string): Promise<ReplicaSnapshot | null>;
  /**
   * Stores the stream as the new latest replica, without the secret profile files; rejects (and keeps
   * the old one) when it breaks off or is not a snapshot the filter can read. `bytes` is the size of
   * what was stored, `excludedPaths` the entries left out.
   */
  write(site: string, botKey: string, stream: Readable): Promise<{ capturedAt: Date; bytes: number; excludedPaths: string[] }>;
}

export interface FleetReplicaStoreOptions {
  /** Datadir paths left out of a stored replica. Defaults to the secret files of the profile compiler. */
  excludePaths?: readonly string[];
}

function segment(value: string, what: string): string {
  if (!SAFE_SEGMENT.test(value) || value.includes("..")) throw new Error(`${what} is not a safe path segment`);
  return value;
}

export function fileFleetReplicaStore(rootDir: string, options: FleetReplicaStoreOptions = {}): FleetReplicaStore {
  const root = path.resolve(rootDir);
  const excludePaths = options.excludePaths ?? PROFILE_SECRET_FILE_PATHS;
  const dirOf = (site: string, botKey: string) => path.join(root, segment(site, "site"), segment(botKey, "botKey"));

  async function capturedAt(site: string, botKey: string): Promise<Date | null> {
    try {
      const info = await stat(path.join(dirOf(site, botKey), "latest.tar.zst"));
      return info.isFile() ? info.mtime : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  return {
    capturedAt,

    async open(site, botKey) {
      const taken = await capturedAt(site, botKey);
      if (!taken) return null;
      return { stream: createReadStream(path.join(dirOf(site, botKey), "latest.tar.zst")), capturedAt: taken };
    },

    async write(site, botKey, stream) {
      const dir = dirOf(site, botKey);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const incoming = path.join(dir, `incoming-${randomUUID()}.tmp`);
      try {
        const out = createWriteStream(incoming, { mode: 0o600 });
        let report: ReplicaFilterReport = { entries: 0, keptEntries: 0, excludedPaths: [] };
        await pipeline(
          stream,
          (source: AsyncIterable<Buffer>) => filterReplicaSnapshot(source, { excludePaths, onReport: (r) => { report = r; } }),
          out,
        );
        const bytes = out.bytesWritten;
        if (bytes === 0) throw new Error("replica stream was empty");
        const latest = path.join(dir, "latest.tar.zst");
        if (await capturedAt(site, botKey)) await rename(latest, path.join(dir, "previous.tar.zst"));
        await rename(incoming, latest);
        return { capturedAt: (await stat(latest)).mtime, bytes, excludedPaths: report.excludedPaths };
      } catch (err) {
        await rm(incoming, { force: true }).catch(() => undefined);
        throw err;
      }
    },
  };
}

/** The store named by MYRMIDON_FLEET_REPLICA_DIR, or null when the variable is not set. */
export function fleetReplicaStoreFromEnv(env: NodeJS.ProcessEnv = process.env): FleetReplicaStore | null {
  const dir = env[FLEET_REPLICA_DIR_ENV]?.trim();
  return dir ? fileFleetReplicaStore(dir) : null;
}
