"use strict";
// docker/bot-runtime/myr-ws/lib/repair.js
//
// myrmidon(MYR-WS-RECOVER): `myr-ws repair [KEY] [--json]` — the same recovery
// `open` applies on reuse (lib/recover.js), for copies nobody is about to open:
// a run that was interrupted (maintenance drain, kill, crash) mid merge/rebase/
// cherry-pick leaves the copy in that state until the next run of the task, which
// may be hours away. botd calls this verb when no run is going; a copy with a
// process whose working directory is inside it is skipped.
//
// Only unfinished operations are repaired here (no branch policy: the registry
// follows branch changes in `open`). The state is saved to refs/myr-ws/recovery/<KEY>
// before anything is aborted, so no change is lost.

const fs = require("node:fs");
const open = require("./open.js");
const recover = require("./recover.js");

/** cli handler: ({ positionals, env }, deps) -> { repaired, skipped, errors, human } */
async function repair({ positionals = [], env = process.env } = {}, deps = {}) {
  const ctx = open.makeCtx({ ...deps, env });
  const git = open.makeGit(ctx);
  const only = positionals[0] || null;
  if (positionals.length > 1) throw new open.MyrWsError(open.EXIT.usage, "usage: myr-ws repair [KEY] [--json]");
  const reg = open.readRegistry(ctx);
  const repaired = [];
  const skipped = [];
  const errors = [];
  for (const e of reg.entries) {
    if (e.class !== "E" || (only && e.key !== only) || !fs.existsSync(e.path)) continue;
    try {
      const state = recover.inspectCopy(git, e.path, {});
      if (state.broken) {
        errors.push({ key: e.key, path: e.path, error: "git cannot read this copy; left untouched" });
        continue;
      }
      if (!state.problems.some(recover.isHalfWay)) continue;
      const live = recover.hasLiveProcess(e.path, deps.procRoot);
      if (live !== false) {
        skipped.push({ key: e.key, path: e.path, reason: live === true ? "a process is running in the copy" : "cannot tell whether a process runs in the copy" });
        continue;
      }
      const r = recover.recoverCopy(ctx, git, e.path, { key: e.key, expectedBranch: null, explicitBranch: false, baseTarget: null });
      repaired.push({ key: e.key, path: e.path, recovered: r.recovered, ...(r.recoveryRef ? { recoveryRef: r.recoveryRef } : {}) });
    } catch (err) {
      errors.push({ key: e.key, path: e.path, error: String((err && err.message) || err).slice(0, 400) });
    }
  }
  const human =
    [...repaired.map((r) => recover.recoveredSummary(r.key, r.recovered, r.recoveryRef)),
      ...skipped.map((s) => `${s.key}: skipped (${s.reason})`),
      ...errors.map((x) => `${x.key}: error (${x.error})`)].join("\n") + (repaired.length + skipped.length + errors.length ? "\n" : "ok, nothing to repair\n");
  return { repaired, skipped, errors, human };
}

module.exports = { repair };
