// myrmidon(1.6.5-BOT-DISK-H3a): botd client of the desired workspace state
// (contract C3, `GET /api/myrmidon/bots/me/workspaces`, docs/myrmidon/bot-disk-contract).
//
// Fail-safe: every failure (401/403, 5xx, network, timeout, broken JSON, a
// response that does not match the C3 schema) is reported as
// `{ ok: false, reason }`. The caller must treat that as "do not delete
// anything" and only report. The last good answer is kept in `last` with its
// `fetchedAt`, for the report; it is never returned as a success.
//
// Plain Node (no dependencies): the schema of `wsDesiredStateSchema` is
// mirrored by hand and checked against the contract fixtures in the test.

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_INTERVAL_MS = 60_000;
const DESIRED_PATH = "/api/myrmidon/bots/me/workspaces";
const STATES = ["active", "closing"];
const PR_STATES = ["none", "open", "merged", "closed"];
const LEVELS = ["none", "soft", "hard"];
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isDatetime = (v) => typeof v === "string" && DATETIME_RE.test(v) && !Number.isNaN(Date.parse(v));
const isPercent = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
const nonEmpty = (v) => typeof v === "string" && v.length > 0;

/** Validates a C3 body. Returns `{ ok: true, value }` or `{ ok: false, reason }`. */
export function parseDesiredState(body) {
  const bad = (reason) => ({ ok: false, reason: `schema: ${reason}` });
  if (!isObj(body)) return bad("response is not an object");
  if (!isDatetime(body.generatedAt)) return bad("generatedAt is not a UTC datetime");
  const grace = body.grace;
  if (!isObj(grace)) return bad("grace is missing");
  for (const k of ["closingMinutes", "scratchTtlHours", "orphanHours"]) {
    if (!isPosInt(grace[k])) return bad(`grace.${k} is not a positive integer`);
  }
  const pressure = body.pressure;
  if (!isObj(pressure)) return bad("pressure is missing");
  if (pressure.quotaPercent !== null && !isPercent(pressure.quotaPercent)) return bad("pressure.quotaPercent out of range");
  if (!isPercent(pressure.partitionPercent)) return bad("pressure.partitionPercent out of range");
  if (!LEVELS.includes(pressure.level)) return bad("pressure.level is unknown");
  if (!Array.isArray(body.workspaces)) return bad("workspaces is not an array");
  for (let i = 0; i < body.workspaces.length; i += 1) {
    const w = body.workspaces[i];
    const at = `workspaces[${i}]`;
    if (!isObj(w)) return bad(`${at} is not an object`);
    if (!nonEmpty(w.key)) return bad(`${at}.key is empty`);
    if (w.repo !== undefined && !(typeof w.repo === "string" && REPO_RE.test(w.repo))) return bad(`${at}.repo is not owner/name`);
    if (!STATES.includes(w.state)) return bad(`${at}.state is unknown (${JSON.stringify(String(w.state)).slice(0, 40)})`);
    if (!isDatetime(w.since)) return bad(`${at}.since is not a UTC datetime`);
    if (!PR_STATES.includes(w.prState)) return bad(`${at}.prState is unknown`);
    if (w.branch !== undefined && !nonEmpty(w.branch)) return bad(`${at}.branch is empty`);
  }
  if (body.protectKeys !== undefined && !(Array.isArray(body.protectKeys) && body.protectKeys.every((k) => typeof k === "string"))) {
    return bad("protectKeys is not an array of strings");
  }
  return { ok: true, value: body };
}

function desiredUrl(env) {
  const base = String(env.PAPERCLIP_API_URL || "").trim().replace(/\/+$/, "").replace(/\/api$/, "");
  return base ? `${base}${DESIRED_PATH}` : null;
}

/**
 * @param {object} [opts]
 * @param {object} [opts.env]       process.env-like: PAPERCLIP_API_URL, PAPERCLIP_API_KEY
 * @param {Function} [opts.fetchImpl]
 * @param {(line: string) => void} [opts.log]
 * @param {() => Date} [opts.now]
 * @param {number} [opts.timeoutMs]  default 10 s
 * @param {number} [opts.intervalMs] default 60 s
 * @param {(result: object) => void} [opts.onResult]  called after every poll (start())
 */
export function createDesiredClient(opts = {}) {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  /** Last good answer: `{ state, fetchedAt }` or null. Never a success of a later poll. */
  let last = null;
  let timer = null;
  let inFlight = null;
  let onSignal = null;

  // The key must never reach a log or a reason string.
  const redact = (text) => {
    const key = env.PAPERCLIP_API_KEY;
    let out = String(text);
    if (key) out = out.split(key).join("[redacted]");
    return out;
  };
  const fail = (reason) => {
    const safe = redact(reason);
    log(`botd desired: ${safe}`);
    return { ok: false, reason: safe, last };
  };

  async function pollOnce() {
    const key = env.PAPERCLIP_API_KEY;
    if (!key) return fail("PAPERCLIP_API_KEY is not set");
    const url = desiredUrl(env);
    if (!url) return fail("PAPERCLIP_API_URL is not set");
    if (typeof fetchImpl !== "function") return fail("fetch is not available");
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetchImpl(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
          signal: ctl.signal,
        });
      } catch (err) {
        if (ctl.signal.aborted) return fail(`timeout after ${timeoutMs} ms`);
        return fail(`network error: ${err && err.code ? err.code : err && err.name ? err.name : "unknown"}`);
      }
      if (res.status === 401 || res.status === 403) return fail(`auth rejected: HTTP ${res.status}`);
      if (res.status < 200 || res.status >= 300) return fail(`HTTP ${res.status}`);
      let body;
      try {
        body = JSON.parse(await res.text());
      } catch (err) {
        return ctl.signal.aborted ? fail(`timeout after ${timeoutMs} ms`) : fail("response is not valid JSON");
      }
      const parsed = parseDesiredState(body);
      if (!parsed.ok) return fail(parsed.reason);
      const fetchedAt = now().toISOString();
      last = { state: parsed.value, fetchedAt };
      return { ok: true, state: parsed.value, fetchedAt };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** One poll; concurrent callers (timer + SIGUSR1) share the in-flight request. */
  function poll() {
    if (!inFlight) {
      inFlight = pollOnce().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  async function tick() {
    let result;
    try {
      result = await poll();
    } catch (err) {
      result = fail(`unexpected error: ${err && err.message ? err.message : err}`);
    }
    if (opts.onResult) {
      try {
        opts.onResult(result);
      } catch (err) {
        log(`botd desired: onResult failed: ${redact(err && err.message ? err.message : err)}`);
      }
    }
    return result;
  }

  /** Polls now, then every `intervalMs`, and on SIGUSR1 (run wake-up). */
  function start(proc = process) {
    if (timer) return;
    const schedule = () => {
      timer = setTimeout(async () => {
        await tick();
        if (timer) schedule();
      }, intervalMs);
      timer.unref?.();
    };
    timer = true;
    tick().finally(() => {
      if (timer === true) schedule();
    });
    onSignal = () => {
      void tick();
    };
    proc.on("SIGUSR1", onSignal);
    start.proc = proc;
  }

  function stop() {
    if (timer && timer !== true) clearTimeout(timer);
    timer = null;
    if (onSignal && start.proc) start.proc.off("SIGUSR1", onSignal);
    onSignal = null;
  }

  return { poll, tick, start, stop, getLast: () => last };
}

export const DESIRED_DEFAULTS = Object.freeze({ timeoutMs: DEFAULT_TIMEOUT_MS, intervalMs: DEFAULT_INTERVAL_MS, path: DESIRED_PATH });
