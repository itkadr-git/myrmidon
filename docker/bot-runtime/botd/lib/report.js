// myrmidon(1.6.5-BOT-DISK-H3e): botd disk report (contract C4,
// `POST /api/myrmidon/bots/me/disk-report`, docs/myrmidon/bot-disk-contract).
//
// Plain Node, no dependencies: the schema of `wsDiskReportSchema` is mirrored by
// hand (`validateReport`) and checked against the contract fixtures in the test.
// A report that does not pass the check is never sent (the board would answer
// 400); the reason goes to the log instead.
//
// The API key never reaches a log line or a reason string.

export const REPORT_PATH = "/api/myrmidon/bots/me/disk-report";
export const MAX_BODY_BYTES = 1024 * 1024; // WS_DISK_REPORT_MAX_BODY_BYTES
export const MAX_ACTIONS = 200; // WS_DISK_REPORT_MAX_ACTIONS
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([2_000, 8_000]); // 3 attempts per pass

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COPY_CLASSES = ["E", "G", "X"];
const ACTIONS = ["remove", "archive", "restore", "open", "skip"];
const RESULTS = ["ok", "error", "skipped"];
const SIGNS = ["promisor", "token", "no-remote", "trash", "full-clone"];

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v, min = 1, max = Infinity) => typeof v === "string" && v.length >= min && v.length <= max;
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const isDatetime = (v) => typeof v === "string" && DATETIME_RE.test(v) && !Number.isNaN(Date.parse(v));
const isTri = (v) => v === null || typeof v === "boolean";
const isRepo = (v) => typeof v === "string" && REPO_RE.test(v);

/** Validates a C4 body. Returns `{ ok: true }` or `{ ok: false, reason }`. */
export function validateReport(r) {
  const bad = (reason) => ({ ok: false, reason });
  if (!isObj(r)) return bad("report is not an object");
  if (r.schema !== 1) return bad("schema must be 1");
  if (!isStr(r.botKey, 1, 200)) return bad("botKey is empty or longer than 200");
  if (!isStr(r.imageGeneration, 1, 100)) return bad("imageGeneration is empty or longer than 100");
  if (!isDatetime(r.at)) return bad("at is not a UTC datetime");
  if (!isObj(r.selfChecks)) return bad("selfChecks is missing");
  for (const k of ["reflink", "gitref", "wsCli"]) {
    if (!isTri(r.selfChecks[k])) return bad(`selfChecks.${k} is not boolean|null`);
  }
  for (const k of ["bases", "copies", "archives", "actions", "foreign"]) {
    if (!Array.isArray(r[k])) return bad(`${k} is not an array`);
  }
  if (r.actions.length > MAX_ACTIONS) return bad(`actions has more than ${MAX_ACTIONS} items`);
  r.bases.forEach((b, i) => {
    if (bad.reason) return;
    const at = `bases[${i}]`;
    if (!isObj(b)) bad.reason = `${at} is not an object`;
    else if (!isRepo(b.repo)) bad.reason = `${at}.repo is not owner/name`;
    else if (!isStr(b.path)) bad.reason = `${at}.path is empty`;
    else if (b.sizeBytes !== null && !isNonNegInt(b.sizeBytes)) bad.reason = `${at}.sizeBytes is not int|null`;
    else if (b.lastFetchAt !== null && !isDatetime(b.lastFetchAt)) bad.reason = `${at}.lastFetchAt is not datetime|null`;
  });
  r.copies.forEach((c, i) => {
    if (bad.reason) return;
    const at = `copies[${i}]`;
    if (!isObj(c)) bad.reason = `${at} is not an object`;
    else if (!isStr(c.path)) bad.reason = `${at}.path is empty`;
    else if (!COPY_CLASSES.includes(c.class)) bad.reason = `${at}.class is unknown`;
    else if (c.key !== undefined && !isStr(c.key)) bad.reason = `${at}.key is empty`;
    else if (c.repo !== undefined && !isRepo(c.repo)) bad.reason = `${at}.repo is not owner/name`;
    else if (c.branch !== undefined && !isStr(c.branch)) bad.reason = `${at}.branch is empty`;
    else if (!isTri(c.clean)) bad.reason = `${at}.clean is not boolean|null`;
    else if (!isTri(c.pushed)) bad.reason = `${at}.pushed is not boolean|null`;
    else if (c.sizeBytes !== null && !isNonNegInt(c.sizeBytes)) bad.reason = `${at}.sizeBytes is not int|null`;
    else if (!isNonNegInt(c.ageSec)) bad.reason = `${at}.ageSec is not a non-negative int`;
    else if (c.reason !== undefined && !isStr(c.reason, 0, 500)) bad.reason = `${at}.reason is longer than 500`;
  });
  r.archives.forEach((a, i) => {
    if (bad.reason) return;
    const at = `archives[${i}]`;
    if (!isObj(a)) bad.reason = `${at} is not an object`;
    else if (!isStr(a.key)) bad.reason = `${at}.key is empty`;
    else if (!isStr(a.path)) bad.reason = `${at}.path is empty`;
    else if (!isNonNegInt(a.sizeBytes)) bad.reason = `${at}.sizeBytes is not a non-negative int`;
    else if (!isDatetime(a.createdAt)) bad.reason = `${at}.createdAt is not a UTC datetime`;
  });
  r.actions.forEach((a, i) => {
    if (bad.reason) return;
    const at = `actions[${i}]`;
    if (!isObj(a)) bad.reason = `${at} is not an object`;
    else if (!isDatetime(a.at)) bad.reason = `${at}.at is not a UTC datetime`;
    else if (!ACTIONS.includes(a.action)) bad.reason = `${at}.action is unknown`;
    else if (!isStr(a.path)) bad.reason = `${at}.path is empty`;
    else if (!RESULTS.includes(a.result)) bad.reason = `${at}.result is unknown`;
    else if (a.detail !== undefined && !isStr(a.detail, 0, 500)) bad.reason = `${at}.detail is longer than 500`;
  });
  r.foreign.forEach((f, i) => {
    if (bad.reason) return;
    const at = `foreign[${i}]`;
    if (!isObj(f)) bad.reason = `${at} is not an object`;
    else if (!isStr(f.path)) bad.reason = `${at}.path is empty`;
    else if (!SIGNS.includes(f.sign)) bad.reason = `${at}.sign is unknown`;
  });
  if (bad.reason) return { ok: false, reason: bad.reason };
  return { ok: true };
}

const clip = (text, n) => {
  const s = String(text ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/**
 * Assembles a C4 body from the parts one pass gathered. It only shapes and
 * trims: `actions` keeps the last 200 (the report is a snapshot, not a log),
 * `detail`/`reason` are cut to 500 characters, and when the body would pass
 * 1 MiB the longest lists are cut from the tail until it fits.
 */
export function buildReport(parts) {
  const at = parts.at instanceof Date ? parts.at : new Date(parts.at ?? Date.now());
  const report = {
    schema: 1,
    botKey: clip(parts.botKey, 200),
    imageGeneration: clip(parts.imageGeneration || "unknown", 100),
    at: at.toISOString(),
    selfChecks: {
      reflink: parts.selfChecks?.reflink ?? null,
      gitref: parts.selfChecks?.gitref ?? null,
      wsCli: parts.selfChecks?.wsCli ?? null,
    },
    bases: [...(parts.bases ?? [])],
    copies: (parts.copies ?? []).map((c) => (c.reason === undefined ? c : { ...c, reason: clip(c.reason, 500) })),
    archives: [...(parts.archives ?? [])],
    actions: (parts.actions ?? [])
      .slice(-MAX_ACTIONS)
      .map((a) => (a.detail === undefined ? a : { ...a, detail: clip(a.detail, 500) })),
    foreign: [...(parts.foreign ?? [])],
  };
  const size = () => Buffer.byteLength(JSON.stringify(report));
  for (const key of ["copies", "foreign", "archives", "bases", "actions"]) {
    while (size() > MAX_BODY_BYTES && report[key].length > 0) {
      report[key].length = Math.floor(report[key].length / 2);
    }
  }
  return report;
}

function reportUrl(env) {
  const base = String(env.PAPERCLIP_API_URL || "").trim().replace(/\/+$/, "").replace(/\/api$/, "");
  return base ? `${base}${REPORT_PATH}` : null;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} [opts]
 * @param {object} [opts.env]        PAPERCLIP_API_URL, PAPERCLIP_API_KEY
 * @param {Function} [opts.fetchImpl]
 * @param {(line: string) => void} [opts.log]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {number} [opts.timeoutMs]  per attempt, default 10 s
 * @param {number[]} [opts.retryDelaysMs] delays between attempts, default [2 s, 8 s]
 */
export function createReporter(opts = {}) {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  const redact = (text) => {
    const key = env.PAPERCLIP_API_KEY;
    let out = String(text);
    if (key) out = out.split(key).join("[redacted]");
    return out;
  };

  async function attempt(url, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.PAPERCLIP_API_KEY}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body,
          signal: ctl.signal,
        });
      } catch (err) {
        if (ctl.signal.aborted) return { ok: false, retry: true, reason: `timeout after ${timeoutMs} ms` };
        return { ok: false, retry: true, reason: `network error: ${err && err.code ? err.code : err && err.name ? err.name : "unknown"}` };
      }
      // 4xx other than 408/429: the board refused this body; sending it again changes nothing.
      if (res.status >= 200 && res.status < 300) {
        let json;
        try {
          json = JSON.parse(await res.text());
        } catch {
          return { ok: false, retry: false, reason: "response is not valid JSON" };
        }
        if (!isObj(json) || json.ok !== true || !Number.isInteger(json.nextReportSec) || json.nextReportSec <= 0) {
          return { ok: false, retry: false, reason: "response does not match wsDiskReportResponseSchema" };
        }
        return { ok: true, nextReportSec: json.nextReportSec };
      }
      const retry = res.status >= 500 || res.status === 408 || res.status === 429;
      return { ok: false, retry, reason: `HTTP ${res.status}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Sends one report: validates it, then POSTs with retries and backoff.
   * Never throws. Returns `{ ok: true, nextReportSec }` or `{ ok: false, reason }`.
   */
  async function send(report) {
    const checked = validateReport(report);
    if (!checked.ok) {
      log(`botd report: not sent, invalid: ${redact(checked.reason)}`);
      return { ok: false, reason: `invalid report: ${checked.reason}` };
    }
    if (!env.PAPERCLIP_API_KEY) return { ok: false, reason: "PAPERCLIP_API_KEY is not set" };
    const url = reportUrl(env);
    if (!url) return { ok: false, reason: "PAPERCLIP_API_URL is not set" };
    if (typeof fetchImpl !== "function") return { ok: false, reason: "fetch is not available" };
    const body = JSON.stringify(report);
    let last = { ok: false, reason: "not attempted" };
    for (let i = 0; i <= delays.length; i += 1) {
      try {
        last = await attempt(url, body);
      } catch (err) {
        last = { ok: false, retry: true, reason: `unexpected error: ${err && err.message ? err.message : err}` };
      }
      if (last.ok) return { ok: true, nextReportSec: last.nextReportSec };
      last.reason = redact(last.reason);
      log(`botd report: attempt ${i + 1} failed: ${last.reason}`);
      if (!last.retry || i === delays.length) break;
      await sleep(delays[i]);
    }
    return { ok: false, reason: last.reason };
  }

  return { send };
}
