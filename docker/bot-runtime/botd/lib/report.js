// myrmidon(1.6.5-BOT-DISK-H3e): the board client of botd — desired state
// (C3, GET /api/myrmidon/bots/me/workspaces) and the disk report (C4, POST
// /api/myrmidon/bots/me/disk-report, body ≤ 1 MiB, actions ≤ 200). Fetch
// injection keeps the module free of the network in tests; every failure is
// fail-safe (desired.ok=false deletes nothing, a report failure retries once
// after a short delay).
"use strict";

const REPORT_PATH = "/api/myrmidon/bots/me/disk-report";
const DESIRED_PATH = "/api/myrmidon/bots/me/workspaces";
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ACTIONS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The report body botd sends; `actions` is capped at the contract's 200. */
function buildReport({ inventory, actions, now, selfChecks, botKey, imageGeneration }) {
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
 * The desired state of this bot. Fail-safe: every transport or board failure
 * resolves to `{ok:false}` — the loop treats it as "delete nothing".
 */
async function fetchDesiredState({ boardUrl, apiKey, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  try {
    const res = await doFetch(`${boardUrl}${DESIRED_PATH}`, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", connection: "close" },
    });
    if (!res.ok) {
      return { ok: false, error: `desired-state HTTP ${res.status}` };
    }
    const state = await res.json();
    if (!state || !Array.isArray(state.workspaces) || !state.grace || !state.pressure) {
      return { ok: false, error: "desired-state payload failed the C3 shape" };
    }
    return { ok: true, state };
  } catch (err) {
    return { ok: false, error: `desired-state fetch failed: ${err && err.message ? err.message : err}` };
  }
}

/**
 * POSTs the report once, then retries a single time after `retryDelayMs` when
 * the first attempt failed at transport level or with a 5xx. A 4xx is a
 * contract violation — no retry. Never throws: the loop must survive a down
 * board.
 */
async function postReport({ boardUrl, apiKey, fetchImpl, body, retryDelayMs = 30_000 }) {
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

module.exports = {
  buildReport,
  fetchDesiredState,
  postReport,
  REPORT_PATH,
  DESIRED_PATH,
  MAX_BODY_BYTES,
  MAX_ACTIONS,
};
