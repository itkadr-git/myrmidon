// server/src/myrmidon/bot-containers/fleet-replica-store.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T4): the board-side store of datadir replicas (remote-sites-v2 4.4).
//
// A site that dies takes its datadirs with it, so the board keeps the last snapshot of every bot
// of a remote site on its own disk: <root>/<site>/<botKey>/latest.tar.zst (the previous one stays
// as previous.tar.zst). The snapshot is the site-agent's own stream (tar in a zstd frame ending
// with a manifest that restore verifies), stored as it came, never unpacked here.
//
// A replica is written to a temporary file in the same directory and renamed over `latest` only
// after the whole stream arrived, so a stream that broke off never replaces a good replica.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { ReplicaSnapshot } from "./fleet-move-service.js";

export const FLEET_REPLICA_DIR_ENV = "MYRMIDON_FLEET_REPLICA_DIR";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface FleetReplicaStore {
  /** When the last replica of the bot on `site` was taken, or null when there is none. */
  capturedAt(site: string, botKey: string): Promise<Date | null>;
  open(site: string, botKey: string): Promise<ReplicaSnapshot | null>;
  /** Stores the stream as the new latest replica; rejects (and keeps the old one) when it breaks off. */
  write(site: string, botKey: string, stream: Readable): Promise<{ capturedAt: Date; bytes: number }>;
}

function segment(value: string, what: string): string {
  if (!SAFE_SEGMENT.test(value) || value.includes("..")) throw new Error(`${what} is not a safe path segment`);
  return value;
}

export function fileFleetReplicaStore(rootDir: string): FleetReplicaStore {
  const root = path.resolve(rootDir);
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
        await pipeline(stream, out);
        const bytes = out.bytesWritten;
        if (bytes === 0) throw new Error("replica stream was empty");
        const latest = path.join(dir, "latest.tar.zst");
        if (await capturedAt(site, botKey)) await rename(latest, path.join(dir, "previous.tar.zst"));
        await rename(incoming, latest);
        return { capturedAt: (await stat(latest)).mtime, bytes };
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
