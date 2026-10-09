// myrmidon(1.6.5-BOT-DISK-H): the two path-keyed caches that keep a failing
// cleanup rule from spamming the log and the report:
//   * attention  — `$MYRMIDON_WS_HOME/botd-attention.json`, {path: {reason, uid, at}}:
//     a deferred path is announced once per TTL (default 1 h); repeated passes stay
//     silent while the entry is fresh;
//   * cooldown   — `$MYRMIDON_WS_HOME/botd-cooldown.json`, {path: {op, result, at}}:
//     the same op on the same path is not attempted again within the TTL (< 1 h is a
//     silent skip, no log line, no report row).
// Both files are best-effort state: a broken or unwritable cache makes every entry
// look fresh (the rule runs again, loudly once) and never breaks the pass.

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_TTL_MS = 3_600_000; // 1 hour

function loadCache(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function storeCache(file, cache) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o644 });
    fs.renameSync(tmp, file);
  } catch {
    /* the cache is an optimisation, not data: a failed write only loses the silence */
  }
}

const fresh = (entry, nowMs, ttlMs) =>
  !!entry && Number.isFinite(Date.parse(entry.at)) && nowMs - Date.parse(entry.at) < ttlMs;

/**
 * One attention signal per path per TTL.
 * @param {string} file botd-attention.json
 * @param {{now?:() => Date, log?:(l: string) => void, ttlMs?:number}} [opts]
 */
export function createAttention(file, opts = {}) {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  return {
    /**
     * Emits the attention line unless this path+reason was announced within the TTL.
     * @param {string} p path
     * @param {{reason?:string, uid?:number|null}} [info] uid goes into the text
     * @returns {boolean} true when the line was emitted
     */
    signal(p, info = {}) {
      const reason = String(info.reason || "deferred");
      const cache = loadCache(file);
      const entry = cache[p];
      if (entry && entry.reason === reason && fresh(entry, now().getTime(), ttlMs)) return false;
      cache[p] = { reason, uid: info.uid ?? null, at: now().toISOString() };
      storeCache(file, cache);
      const uid = info.uid === null || info.uid === undefined ? "" : `, uid ${info.uid}`;
      log(`botd: attention: ${p} deferred (${reason}${uid})`);
      return true;
    },
  };
}

/**
 * Not the same op on the same path more than once per TTL.
 * @param {string} file botd-cooldown.json
 * @param {{now?:() => Date, ttlMs?:number}} [opts]
 */
export function createCooldown(file, opts = {}) {
  const now = opts.now ?? (() => new Date());
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  return {
    /** True when an attempt at (path, op) is younger than the TTL. */
    recent(p, op) {
      const entry = loadCache(file)[p];
      return !!(entry && entry.op === op && fresh(entry, now().getTime(), ttlMs));
    },
    /** Remembers the attempt so the next pass within the TTL stays silent. */
    record(p, op, result) {
      const cache = loadCache(file);
      cache[p] = { op, result: String(result ?? ""), at: now().toISOString() };
      storeCache(file, cache);
    },
  };
}
