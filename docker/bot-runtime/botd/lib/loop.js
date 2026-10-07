// myrmidon(1.6.5-BOT-DISK-H3e): botd main loop. One pass = desired state ->
// inventory -> rules.plan -> execution -> disk-state.json -> disk report.
//
// Every module is injected (`deps`), so the pass is testable with fakes and the
// real modules (desired H3a, rules H3b, archive H3c, classify H3d) plug in by
// their interfaces from the bot-disk contract:
//
//   desired.poll()            -> { ok: true, state } | { ok: false, reason }
//   gather(desired|null)      -> { inventory: { worktrees, scratch, bases, archives },
//                                  parts: { copies, foreign, bases, archives, selfChecks } }
//   rules.plan(inv, state, now, settings) -> { actions: [{ op, path, reason, key? }] }
//   executor[op](action)      -> detail string | { detail } ; throws on failure
//        ops: remove, archive-remove, prune, delete-base, delete-archive
//   report.build(parts) / report.send(report) -> { ok, nextReportSec }
//   writeDiskState(state)     -> writes /data/hermes/.myrmidon/disk-state.json
//
// Safety rules of this file:
//  * nothing is executed unless the board's desired state arrived and parsed
//    (`desired.ok === true`): without it the pass only reports (fail-safe);
//  * an action that throws is reported as `error` and the pass goes on;
//  * an op with no executor is `skipped`, never guessed;
//  * the loop never throws out of `runOnce`: a broken pass is logged and the next
//    one starts on time.

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_DELAY_MS = 10_000;

// contract C4 `actions[].action` for each rules op
const REPORT_ACTION = Object.freeze({
  remove: "remove",
  "archive-remove": "archive",
  prune: "remove",
  "delete-base": "remove",
  "delete-archive": "remove",
});

const errMessage = (err) => String(err && err.message ? err.message : err).replace(/\s+/g, " ").slice(0, 400);

/**
 * @param {object} deps  see the header; `now` (() => Date), `log`, `settings`,
 *   `botKey`, `imageGeneration`, `intervalMs`, `setTimer`/`clearTimer` are optional.
 */
export function createLoop(deps) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const executor = deps.executor ?? {};
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;

  let running = null;
  let rerun = false;
  let timer = null;
  let onSignal = null;
  let stopped = true;
  let nextDelayMs = intervalMs;

  const emptyGather = { inventory: { worktrees: [], scratch: [], bases: [], archives: [] }, parts: {} };

  async function gatherSafe(desiredState) {
    try {
      const g = await deps.gather(desiredState);
      return { ok: true, inventory: g?.inventory ?? emptyGather.inventory, parts: g?.parts ?? {} };
    } catch (err) {
      log(`botd loop: inventory failed: ${errMessage(err)}`);
      return { ok: false, reason: errMessage(err), ...emptyGather };
    }
  }

  async function execute(action, results) {
    const at = () => now().toISOString();
    const reportAction = REPORT_ACTION[action.op];
    const detail = (text) => `${action.op}: ${action.reason ?? ""}${text ? ` — ${text}` : ""}`.slice(0, 500);
    if (!reportAction) {
      results.push({ at: at(), action: "skip", path: action.path, result: "skipped", detail: detail("unknown op") });
      return;
    }
    const fn = executor[action.op];
    if (typeof fn !== "function") {
      results.push({ at: at(), action: "skip", path: action.path, result: "skipped", detail: detail("no executor for this op") });
      return;
    }
    try {
      const out = await fn(action);
      const text = typeof out === "string" ? out : out && typeof out.detail === "string" ? out.detail : "";
      results.push({ at: at(), action: reportAction, path: action.path, result: "ok", detail: detail(text) });
    } catch (err) {
      log(`botd loop: ${action.op} failed: ${errMessage(err)}`);
      results.push({ at: at(), action: reportAction, path: action.path, result: "error", detail: detail(errMessage(err)) });
    }
  }

  /** One full pass. Never throws. Returns `{ desiredOk, executed, report, sent }`. */
  async function runOnce() {
    const startedAt = now();
    const results = [];
    let desired;
    try {
      desired = await deps.desired.poll();
    } catch (err) {
      desired = { ok: false, reason: `unexpected error: ${errMessage(err)}` };
    }
    const desiredOk = desired?.ok === true && desired.state != null;

    let g = await gatherSafe(desiredOk ? desired.state : null);

    if (!desiredOk) {
      results.push({
        at: startedAt.toISOString(),
        action: "skip",
        path: "/",
        result: "skipped",
        detail: `nothing removed, no desired state: ${desired?.reason ?? "unknown"}`.slice(0, 500),
      });
    } else if (!g.ok) {
      results.push({
        at: startedAt.toISOString(),
        action: "skip",
        path: "/",
        result: "skipped",
        detail: `nothing removed, inventory failed: ${g.reason}`.slice(0, 500),
      });
    } else {
      let actions = [];
      try {
        const planned = deps.rules.plan(g.inventory, desired.state, startedAt.getTime(), deps.settings);
        actions = Array.isArray(planned?.actions) ? planned.actions : [];
      } catch (err) {
        log(`botd loop: rules failed: ${errMessage(err)}`);
        results.push({
          at: startedAt.toISOString(),
          action: "skip",
          path: "/",
          result: "skipped",
          detail: `nothing removed, rules failed: ${errMessage(err)}`.slice(0, 500),
        });
      }
      for (const action of actions) await execute(action, results);
      if (results.some((r) => r.result === "ok")) g = await gatherSafe(desired.state); // the report shows the disk after the pass
    }

    if (desiredOk && typeof deps.writeDiskState === "function") {
      const p = desired.state.pressure ?? {};
      try {
        await deps.writeDiskState({
          version: 1,
          quotaPercent: p.quotaPercent ?? null,
          partitionPercent: p.partitionPercent,
          pressure: p.level,
          updatedAt: now().toISOString().replace(/\.\d{3}Z$/, "Z"),
        });
      } catch (err) {
        log(`botd loop: disk-state.json not written: ${errMessage(err)}`);
      }
    }

    let report = null;
    let sent = { ok: false, reason: "not built" };
    try {
      report = deps.report.build({
        botKey: deps.botKey,
        imageGeneration: deps.imageGeneration,
        at: now(),
        selfChecks: g.parts.selfChecks,
        bases: g.parts.bases,
        copies: g.parts.copies,
        archives: g.parts.archives,
        foreign: g.parts.foreign,
        actions: results,
      });
      sent = await deps.report.send(report);
    } catch (err) {
      sent = { ok: false, reason: errMessage(err) };
      log(`botd loop: report failed: ${sent.reason}`);
    }
    nextDelayMs = sent.ok ? Math.max(MIN_DELAY_MS, Math.min(intervalMs, sent.nextReportSec * 1000)) : intervalMs;
    return { desiredOk, executed: results, report, sent };
  }

  /** Single-flight: a call during a running pass schedules exactly one more pass. */
  function trigger() {
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      let result;
      try {
        do {
          rerun = false;
          result = await runOnce();
        } while (rerun && !stopped);
      } catch (err) {
        log(`botd loop: pass failed: ${errMessage(err)}`);
      } finally {
        running = null;
      }
      return result;
    })();
    return running;
  }

  function schedule() {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(async () => {
      timer = null;
      await trigger();
      schedule();
    }, nextDelayMs);
  }

  /** Runs now, then every interval, and on SIGUSR1 (a run woke the bot). */
  function start(proc = process) {
    if (!stopped) return;
    stopped = false;
    onSignal = () => {
      if (timer) clearTimer(timer);
      timer = null;
      void trigger().finally(schedule);
    };
    proc.on("SIGUSR1", onSignal);
    start.proc = proc;
    void trigger().finally(schedule);
  }

  function stop() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
    if (onSignal && start.proc) start.proc.off("SIGUSR1", onSignal);
    onSignal = null;
    return running ?? Promise.resolve();
  }

  return { runOnce, trigger, start, stop };
}
