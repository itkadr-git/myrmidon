// myrmidon(1.6.5-BOT-DISK-H3e): the board client of botd — the disk report
// (C4, POST /api/myrmidon/bots/me/disk-report, body ≤ 1 MiB, actions ≤ 200)
// and the report body builder. Fetch injection keeps the module free of the
// network in tests; a report failure retries once after a short delay and
// never throws (the loop must survive a down board).
//
// The desired state (C3) is the sibling module's job: lib/desired.js
// (#740, createDesiredClient). It used to live here; the stitching of
// 07.10 moved it out — nothing imports fetchDesiredState anymore.
//
// ESM, like every module of docker/bot-runtime/botd (package.json
// {"type":"module"}).

export const REPORT_PATH = "/api/myrmidon/bots/me/disk-report";
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_ACTIONS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The report body botd sends; `actions` is capped at the contract's 200. */
export function buildReport({ inventory, actions, now, selfChecks, botKey, imageGeneration }) {
  const at = (now || new Date()).toISOString().replace(/\.\d+Z$/, "Z");
  const copies = inventory.copies.map((copy) => ({
    path: copy.path,
    class: copy.class,
    ...(copy.key ? { key: copy.key } : {}),
    ...(copy.repo ? { repo: copy.repo } : {}),
    ...(copy.branch ? { branch: copy.branch } : {}),
    clean: copy.clean ?? null,
    pushed: copy.pushed ?? null,
    sizeBytes: copy.sizeBytes ?? null,
    ageSec: copy.ageSec ?? 0,
    ...(copy.reason ? { reason: String(copy.reason).slice(0, 500) } : {}),
  }));
  const foreign = (inventory.foreign || []).map((f) => ({ path: f.path, sign: f.sign }));
  return {
    schema: 1,
    botKey,
    imageGeneration,
    at,
    selfChecks: {
      reflink: selfChecks?.reflink ?? null,
      gitref: selfChecks?.gitref ?? null,
      wsCli: selfChecks?.wsCli ?? null,
    },
    bases: inventory.bases || [],
    copies,
    archives: inventory.archives || [],
    actions: (actions || []).slice(-MAX_ACTIONS),
    foreign,
  };
}

/**
 * POSTs the report once, then retries a single time after `retryDelayMs` when
 * the first attempt failed at transport level or with a 5xx. A 4xx is a
 * contract violation — no retry. Never throws: the loop must survive a down
 * board.
 */
export async function postReport({ boardUrl, apiKey, fetchImpl, body, retryDelayMs = 30_000 }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload, "utf8") > MAX_BODY_BYTES) {
    return { ok: false, error: "report body over 1 MiB", attempts: 0 };
  }
  const attempt = async () => {
    try {
      const res = await doFetch(`${boardUrl}${REPORT_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
          connection: "close",
        },
        body: payload,
      });
      if (res.ok) {
        let parsed = null;
        try {
          parsed = await res.json();
        } catch {
          /* ok:true with an unreadable body still counts as delivered */
        }
        return { ok: true, nextReportSec: parsed && parsed.nextReportSec ? parsed.nextReportSec : null };
      }
      return { ok: false, status: res.status, error: `disk-report HTTP ${res.status}`, retryable: res.status >= 500 };
    } catch (err) {
      return { ok: false, error: `disk-report fetch failed: ${err && err.message ? err.message : err}`, retryable: true };
    }
  };
  const first = await attempt();
  if (first.ok) return { ...first, attempts: 1 };
  if (!first.retryable) return { ...first, attempts: 1 };
  if (retryDelayMs > 0) await sleep(retryDelayMs);
  const second = await attempt();
  return { ...second, attempts: 2 };
}

