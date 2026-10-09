// myrmidon(1.6.5-BOT-DISK-H3e): botd main loop. One pass = desired state ->
// inventory -> rules.plan -> execution -> disk-state.json -> disk report.
//
// Tick pacing (BOT-DISK-H LOAD): the board's report answer { ok, nextReportSec }
// is the cadence of the whole pass — desired-state is polled and the disk report
// is sent no more often than once per nextReportSec. `intervalMs` is only the
// bootstrap delay until the first accepted answer; a failed pass backs off
// exponentially (intervalMs * 2^k, floor MIN_DELAY_MS, cap MAX_DELAY_MS) with ±10 % jitter so
// a fleet that lost the board does not retry in lockstep. A successful pass
// pauses for nextReportSec * 1000 with 0..+10 % jitter — never shorter, so the
// "not more often than nextReportSec" guarantee holds even under jitter.
// SIGUSR1 is an immediate wake-up and is not bound by the pacing.
//
// Every module is injected (`deps`), so the pass is testable with fakes and the
// real modules (desired H3a, rules H3b, archive H3c, classify H3d) plug in by
// their interfaces from the bot-disk contract:
//
//   desired.poll()            -> { ok: true, state } | { ok: false, reason }
//   gather(desired|null)      -> { inventory: { worktrees, scratch, bases, archives },
//                                  parts: { copies, foreign, bases, archives, selfChecks } }
//   rules.plan(inv, state, now, settings) -> { actions: [{ op, path, reason, key? }] }
//   executor[op](action)      -> detail string | { detail } | { deferred, detail } ; throws on failure
//        ops: remove, archive-remove, prune, delete-base, delete-archive
//        { deferred } means the path was left exactly where it is (a foreign owner);
//        it is reported as skipped with a `deferred: <class>` detail, not as an error
//   cooldown (optional)       -> { recent(path, op): boolean, record(path, op, result) }
//        the rhythm of the rules: an op already attempted on a path inside the
//        window is skipped silently — no log line, no report row
//   report.build(parts) / report.send(report) -> { ok, nextReportSec }
//   writeDiskState(state)     -> writes /data/hermes/.myrmidon/disk-state.json
//
// Safety rules of this file:
//  * nothing is executed unless the board's desired state arrived and parsed
//    (`desired.ok === true`): without it the pass only reports (fail-safe);
//  * an action that throws is reported as `error` and the pass goes on;
//  * an op with no executor is `skipped`, never guessed;
//  * the loop never throws out of `runOnce`: a broken pass is logged and the next
//    one starts on the backed-off schedule.

const DEFAULT_INTERVAL_MS = 300_000;
const MIN_DELAY_MS = 10_000;
const MAX_DELAY_MS = 3_600_000;
const EXP_STRETCH = 6; // intervalMs * 2^EXP_STRETCH already exceeds MAX_DELAY_MS at every legal intervalMs
const JITTER_RATIO = 0.1; // ±10 % (success pauses jitter 0..+10 % — never below the board's cadence)
// Directories the rules only reported (open elsewhere, unknown key, no task) are listed in the report as skips.
const MAX_HELD_IN_REPORT = 40;

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
 *   `botKey`, `imageGeneration`, `intervalMs` (the initial and backoff base value)
 *   are optional. `setTimer`/`clearTimer`/`jitter` are optional and injected by the tests.
 */
export function createLoop(deps) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const executor = deps.executor ?? {};
  // optional path-keyed rhythm cache (lib/cache.js createCooldown); absent = every action runs
  const cooldown = deps.cooldown ?? null;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  // `jitter` returns a number in [-1, 1]; the tests inject 0 for determinism.
  const jitter = deps.jitter ?? (() => Math.random() * 2 - 1);
  const jittered = (delayMs) => Math.round(delayMs * (1 + JITTER_RATIO * jitter()));
  const clamp = (delayMs) => Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, delayMs));

  let running = null;
  let rerun = false;
  let timer = null;
  let onSignal = null;
  let stopped = true;
  let failedStreak = 0;
  // the board's nextReportSec after the first accepted report; null until then
  let nextReportSec = null;
  let lastDelayMs = clamp(intervalMs);

  const emptyGather = { inventory: { worktrees: [], scratch: [], bases: [], archives: [] }, parts: {} };

  /**
   * Delay until the next tick, in ms (after `tick`, before the next schedule).
   * Success: the board's nextReportSec, floored/capped, stretched by 0..+10 %
   * jitter — one-sided, so a pass never starts sooner than the board's cadence.
   * Failure (desired poll or report send): exponential backoff intervalMs * 2^k
   * over the consecutive failed passes, ±10 % jitter, floor MIN_DELAY_MS, cap
   * MAX_DELAY_MS; a known nextReportSec still floors the wait, so neither path
   * polls desired-state or sends a disk report more often than the cadence.
   */
  function computeDelayMs() {
    const cadenceMs = nextReportSec != null ? clamp(nextReportSec * 1000) : null;
    if (failedStreak > 0) {
      const k = Math.min(failedStreak - 1, EXP_STRETCH);
      const base = clamp(jittered(Math.min(MAX_DELAY_MS, intervalMs * 2 ** k)));
      return Math.min(MAX_DELAY_MS, cadenceMs == null ? base : Math.max(base, cadenceMs));
    }
    if (cadenceMs != null) {
      const up = 1 + JITTER_RATIO * Math.max(0, jitter()); // never below the cadence
      return clamp(Math.round(cadenceMs * up));
    }
    return clamp(intervalMs);
  }

  async function gatherSafe(desiredState) {
    try {
      const g = await deps.gather(desiredState);
      return { ok: true, inventory: g?.inventory ?? emptyGather.inventory, parts: g?.parts ?? {} };
    } catch (err) {
      log(`botd loop: inventory failed: ${errMessage(err)}`);
      return { ok: false, reason: errMessage(err), ...emptyGather };
    }
  }

  async function execute(action, results, tally) {
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
    // rhythm: this op on this path already ran within the window — skip silently
    if (cooldown && cooldown.recent(action.path, action.op)) {
      tally.silent += 1;
      return;
    }
    try {
      const out = await fn(action);
      if (out && typeof out === "object" && typeof out.deferred === "string") {
        // nothing was removed (a foreign owner): skipped, not an error — the executor
        // already raised a one-per-path attention signal through its own cache
        tally.deferred[out.deferred] = (tally.deferred[out.deferred] || 0) + 1;
        results.push({
          at: at(),
          action: "skip",
          path: action.path,
          result: "skipped",
          detail: `${action.op}: ${action.reason ?? ""} — deferred: ${out.deferred}${out.detail ? ` (${out.detail})` : ""}`.slice(0, 500),
        });
        if (cooldown) cooldown.record(action.path, action.op, "deferred");
        return;
      }
      const text = typeof out === "string" ? out : out && typeof out.detail === "string" ? out.detail : "";
      tally.cleaned += 1;
      results.push({ at: at(), action: reportAction, path: action.path, result: "ok", detail: detail(text) });
      if (cooldown) cooldown.record(action.path, action.op, "ok");
    } catch (err) {
      tally.errored += 1;
      log(`botd loop: ${action.op} failed: ${errMessage(err)}`);
      results.push({ at: at(), action: reportAction, path: action.path, result: "error", detail: detail(errMessage(err)) });
      if (cooldown) cooldown.record(action.path, action.op, "error");
    }
  }

  /**
   * One full pass. Never throws. Returns `{ desiredOk, executed, report, sent }`.
   * `{ dryRun: true }` (botd --once --plan): inventory and plan only, nothing is executed,
   * disk-state.json is not written and no report is sent; `planned` and `held` are returned.
   */
  async function runOnce(opts = {}) {
    const dryRun = opts.dryRun === true;
    const startedAt = now();
    const results = [];
    let plannedOut = null;
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
      let held = [];
      try {
        const planned = deps.rules.plan(g.inventory, desired.state, startedAt.getTime(), deps.settings);
        actions = Array.isArray(planned?.actions) ? planned.actions : [];
        held = Array.isArray(planned?.held) ? planned.held : [];
        plannedOut = { actions, held, pressure: planned?.pressure ?? "none" };
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
      for (const h of held.slice(0, MAX_HELD_IN_REPORT)) {
        results.push({
          at: startedAt.toISOString(),
          action: "skip",
          path: h.path,
          result: "skipped",
          detail: `${h.kind}${h.key ? ` ${h.key}` : ""}: kept, reported only`.slice(0, 500),
        });
      }
      if (!dryRun) {
        const tally = { cleaned: 0, deferred: {}, errored: 0, silent: 0 };
        for (const action of actions) await execute(action, results, tally);
        // the pass summary: what the cycle actually touched. Silent when the pass
        // did nothing observable (an all-cooldown pass must not re-spam the log).
        const deferredCount = Object.values(tally.deferred).reduce((s, n) => s + n, 0);
        if (tally.cleaned || deferredCount || tally.errored) {
          const reasons = Object.entries(tally.deferred).map(([k, n]) => `${k}: ${n}`).join(", ");
          const extra = tally.errored ? `${reasons ? ", " : ""}errors: ${tally.errored}` : "";
          log(`botd loop: cleaned ${tally.cleaned}, deferred ${deferredCount}${reasons || extra ? ` (${reasons}${extra})` : ""}`);
        }
      }
      if (!dryRun && results.some((r) => r.result === "ok")) g = await gatherSafe(desired.state); // the report shows the disk after the pass
    }

    if (dryRun) return { desiredOk, executed: [], planned: plannedOut, results, report: null, sent: { ok: false, reason: "dry run" } };

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
    if (sent.ok && Number.isFinite(sent.nextReportSec) && sent.nextReportSec > 0) {
      nextReportSec = sent.nextReportSec;
    }
    // a pass is good only when the desired state arrived AND the board accepted
    // the report; either failure backs the schedule off (the board is in trouble)
    if (desiredOk && sent.ok) failedStreak = 0;
    else failedStreak += 1;
    lastDelayMs = computeDelayMs();
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
    }, lastDelayMs);
  }

  /** Runs now, then on the computed delay, and on SIGUSR1 (a run woke the bot). */
  function start(proc = process) {
    if (!stopped) return;
    stopped = false;
    failedStreak = 0;
    nextReportSec = null;
    lastDelayMs = clamp(intervalMs);
    onSignal = () => {
      // immediate wake-up: the pause never holds a pass a run asked for
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

  return { runOnce, trigger, start, stop, getLastDelayMs: () => lastDelayMs };
}
