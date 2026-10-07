// myrmidon(1.6.5-BOT-DISK-H3b): botd decision function — the deletion rules of
// design section 2.3 as a PURE function. It reads the facts botd gathered
// (inventory), the board's desired state (contract C3) and the settings, and
// returns the actions botd should perform. It does not touch the disk, the
// network or the clock (`now` is a parameter), so every row of the table is
// testable with plain objects. Executing an action is the caller's job.
//
// Contract: docs/myrmidon/bot-disk-contract (C1 layout, C3 desired state,
// C7 settings). Field names of `desired` are the C3 names verbatim.
//
// Inventory (what botd measures; the shape is botd's own, not a board contract):
//   {
//     worktrees: [{ key, path, repo?, dirMissing?, clean, pushed, openedAt }],
//     scratch:   [{ name, path, mtime, isGit, clean, pushed }],
//     bases:     [{ path, repo, worktreeCount, lastUsedAt, localOnlyRefs }],
//     archives:  [{ path, createdAt, sizeBytes }],
//   }
// `localOnlyRefs` = number of refs/heads in the base that are not on origin; a
// base is deleted only when it is exactly 0 (missing/null = unknown = unsafe).
// This shape is the MAIN one: any other producer (the H3d classifier #745) maps
// its output to it with an adapter (toInventory), not the other way round. Input
// of another shape yields no actions (see arr()).
// Timestamps are ISO strings or epoch milliseconds. `clean` = no uncommitted
// or untracked work; `pushed` = every commit of the branch is on origin/*.
//
// Action: { op, path, reason, key? } with op one of
//   'remove' | 'archive-remove' | 'prune' | 'delete-base' | 'delete-archive'.

export const OPS = Object.freeze({
  remove: "remove",
  archiveRemove: "archive-remove",
  prune: "prune",
  deleteBase: "delete-base",
  deleteArchive: "delete-archive",
});

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Defaults mirror WS_BOT_DISK_SETTING_DEFAULTS / the design (sections 2.3, 4).
export const RULE_DEFAULTS = Object.freeze({
  graceClosingMinutes: 30,
  scratchTtlHours: 24,
  orphanHours: 24,
  pressureScratchTtlHours: 1,
  baseIdleDays: 30,
  baseLimit: 8,
  archiveMaxAgeDays: 30,
  archivePressureAgeDays: 7,
  archiveCapBytes: 2 * 1024 * 1024 * 1024,
  // Only under hard pressure: an idle named directory the board does not close is archived and removed after this.
  legacyPressureIdleDays: 7,
});

// Accepts epoch ms, an ISO string or a Date (the loop's clock is a Date; a Date
// used to map to null and made plan() return an empty plan silently).
export function toMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * Effective numbers. The board's `desired.grace` wins over local settings
 * (the board already applied its instance settings), local settings win over
 * the defaults.
 */
function resolveLimits(desired, settings) {
  const s = settings ?? {};
  const g = desired?.grace ?? {};
  const pick = (...vals) => vals.find((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
  return {
    graceClosingMs:
      (pick(g.closingMinutes, s.graceClosingMinutes) ?? RULE_DEFAULTS.graceClosingMinutes) * MIN,
    scratchTtlMs: (pick(g.scratchTtlHours, s.scratchTtlHours) ?? RULE_DEFAULTS.scratchTtlHours) * HOUR,
    orphanMs: (pick(g.orphanHours, s.orphanHours) ?? RULE_DEFAULTS.orphanHours) * HOUR,
    pressureScratchTtlMs:
      (pick(s.pressureScratchTtlHours) ?? RULE_DEFAULTS.pressureScratchTtlHours) * HOUR,
    baseIdleMs: (pick(s.baseIdleDays) ?? RULE_DEFAULTS.baseIdleDays) * DAY,
    baseLimit: pick(s.baseLimit) ?? RULE_DEFAULTS.baseLimit,
    archiveMaxAgeMs: (pick(s.archiveMaxAgeDays) ?? RULE_DEFAULTS.archiveMaxAgeDays) * DAY,
    archivePressureAgeMs:
      (pick(s.archivePressureAgeDays) ?? RULE_DEFAULTS.archivePressureAgeDays) * DAY,
    archiveCapBytes: pick(s.archiveCapBytes) ?? RULE_DEFAULTS.archiveCapBytes,
    legacyPressureIdleMs:
      (pick(g.legacyPressureIdleDays, s.legacyPressureIdleDays) ?? RULE_DEFAULTS.legacyPressureIdleDays) * DAY,
  };
}

// Only a real array is a list; anything else (a foreign shape, null) is empty,
// so a mismatched producer deletes nothing instead of throwing.
const arr = (v) => (Array.isArray(v) ? v : []);

const NAME_PREFIX_RE = /^(?:\.trash-|scratch-|tmp-)+/i;
// `OPE-3873` (a hyphen; digits allowed inside the prefix like the issue key schema) or `ope3282v2` (no hyphen: letters only)
const NAME_KEY_HYPHEN_RE = /^([A-Za-z][A-Za-z0-9]*)-([0-9]+)/;
const NAME_KEY_PLAIN_RE = /^([A-Za-z]+)([0-9]+)/;

/**
 * The task key a directory name stands for, or null. Prefixes `.trash-`,
 * `scratch-`, `tmp-` are dropped, the key is `PREFIX-N` upper-cased and any tail
 * (`v2`, `-stale-rootowned`, `-bench`) is ignored: `ope3282v2` -> OPE-3282,
 * `scratch-ope3213` -> OPE-3213, `OPE-4915-stale-rootowned` -> OPE-4915.
 * Whether the board knows the key is a separate question (see plan()).
 */
export function taskKeyOf(name) {
  const stem = String(name ?? "").replace(NAME_PREFIX_RE, "");
  const m = NAME_KEY_HYPHEN_RE.exec(stem) ?? NAME_KEY_PLAIN_RE.exec(stem);
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
}

const isWorkspaceDir = (sc) => typeof sc.path === "string" && sc.path.startsWith("/workspace/");
// Directories that are never work: removable without an archive once idle (R4).
const REGENERABLE_NAMES = new Set(["node_modules", ".pnpm-store", ".venv", "__pycache__", "dist", ".cache", "target"]);
// Bots' own permanent files live here (51 bots): reported, never reaped.
const NEVER_REAP_NAMES = new Set(["shared"]);
const MIB = 1024 * 1024;

function pressureLevel(desired) {
  const level = desired?.pressure?.level;
  return level === "soft" || level === "hard" ? level : "none";
}

function isDesiredShape(desired) {
  return desired != null && typeof desired === "object" && Array.isArray(desired.workspaces);
}

/**
 * Full plan: the actions plus the pressure flags the caller needs.
 *
 * Fail-safe: no / malformed desired state (board unreachable, 401/403/503)
 * deletes nothing — `actions` is empty (design section 8, last risk).
 *
 * @returns {{ actions: object[], pressure: 'none'|'soft'|'hard', blockOpen: boolean }}
 */
export function plan(inventory, desired, now, settings) {
  const nowMs = toMs(now);
  const pressure = pressureLevel(desired);
  const empty = { actions: [], held: [], pressure, blockOpen: pressure === "hard" };
  if (!isDesiredShape(desired) || nowMs === null) return empty;

  const inv = inventory ?? {};
  const lim = resolveLimits(desired, settings);
  const pressed = pressure !== "none";
  const byKey = new Map(desired.workspaces.map((w) => [w.key, w]));
  const activeKeys = new Set(desired.workspaces.filter((w) => w.state === "active").map((w) => w.key));
  const actions = [];
  const act = (op, path, reason, key) =>
    actions.push(key === undefined ? { op, path, reason } : { op, path, reason, key });

  // --- class E: task worktrees --------------------------------------------
  const activePaths = new Set();
  for (const wt of arr(inv.worktrees)) {
    const want = byKey.get(wt.key);

    if (want?.state === "active") {
      activePaths.add(wt.path);
      // Drift: the bot removed the directory itself. Prune the record; the
      // copy is re-created only by the next `open`.
      if (wt.dirMissing) act(OPS.prune, wt.path, "active-drift-dir-missing", wt.key);
      continue;
    }

    let since;
    let graceMs;
    let tag;
    let merged = false;
    if (want?.state === "closing") {
      since = toMs(want.since);
      graceMs = pressed ? 0 : lim.graceClosingMs;
      tag = "closing";
      merged = want.prState === "merged";
    } else {
      // Not in the board's list at all: a copy made through `open` under an
      // unknown key. Same as closing, with the orphan grace.
      since = toMs(wt.openedAt);
      graceMs = lim.orphanMs;
      tag = "orphan";
    }
    if (since === null) continue; // no usable timestamp: never guess
    if (nowMs - since < graceMs) continue;

    if (wt.dirMissing) {
      act(OPS.prune, wt.path, `${tag}-dir-missing`, wt.key);
    } else if (wt.clean === true && wt.pushed === true) {
      // prState=merged does not relax this: uncommitted edits and commits made
      // after the merge are not delivered. Only clean AND pushed is removed.
      act(OPS.remove, wt.path, merged ? `${tag}-pr-merged` : `${tag}-clean-pushed`, wt.key);
    } else {
      // false, null or undefined all count as unsafe: archive first.
      act(OPS.archiveRemove, wt.path, `${tag}-unpushed`, wt.key);
    }
  }

  // --- class G: scratch and the directories the registry does not own ----
  // Policy (docs/myrmidon/changes/1-6-5-bot-disk-h-rc9-*.md): the board's word about a task
  // key beats any timer; a timer applies only to /scratch and to empty or regenerable
  // directories. Under /workspace, in this order:
  //   1. the copy of an active task (activePaths / activeKeys)       -> nothing
  //   2. key in `protectKeys` (open, assigned to this bot)            -> report `legacy-open`
  //   3. key in `closedKeys` (done/cancelled, board-confirmed)        -> archive-remove after grace
  //   4. key the board lists elsewhere (reassigned, review, PR merged) -> report `legacy-open-elsewhere`
  //   5. a key-like name the board does not know                      -> report `unknown-key`
  //   6. no task: empty/regenerable idle -> remove; otherwise report `non-task`
  // Under hard pressure 4, 5 and 6 are archived and removed once idle for
  // `legacyPressureIdleDays`, except `shared`. Without `closedKeys` / `protectKeys` (an older board)
  // every key-like directory is only reported.
  const protectKeys = new Set(arr(desired.protectKeys));
  const closedKeys = Array.isArray(desired.closedKeys) ? new Set(desired.closedKeys) : null;
  const listedKeys = new Set([...byKey.keys(), ...protectKeys, ...(closedKeys ?? [])]);
  const held = [];
  const hold = (sc, kind, key) => held.push(key === undefined ? { path: sc.path, kind } : { path: sc.path, kind, key });
  const scratchTtl = pressed ? lim.pressureScratchTtlMs : lim.scratchTtlMs;
  for (const sc of arr(inv.scratch)) {
    if (activePaths.has(sc.path) || activeKeys.has(sc.name)) continue;
    const mtime = toMs(sc.mtime);
    const idle = mtime === null ? null : nowMs - mtime;
    const unsafe = !(sc.clean === true && sc.pushed === true);
    const hasNested = Array.isArray(sc.nestedGit) && sc.nestedGit.length > 0;

    if (isWorkspaceDir(sc)) {
      const key = taskKeyOf(sc.name);
      if (key !== null && activeKeys.has(key)) continue;
      const underPressure = pressure === "hard" && idle !== null && idle >= lim.legacyPressureIdleMs;
      if (key !== null && protectKeys.has(key)) {
        hold(sc, "legacy-open", key);
        continue;
      }
      if (key !== null && closedKeys !== null && closedKeys.has(key)) {
        const graceMs = pressed ? 0 : lim.graceClosingMs;
        if (idle === null || idle < graceMs) continue;
        act(OPS.archiveRemove, sc.path, "legacy-closed", key);
        continue;
      }
      if (key !== null && listedKeys.has(key)) {
        hold(sc, "legacy-open-elsewhere", key);
        if (underPressure) act(OPS.archiveRemove, sc.path, "legacy-open-elsewhere-pressure-idle", key);
        continue;
      }
      if (key !== null) {
        hold(sc, "unknown-key", key);
        continue;
      }
      // no task behind the name
      const trivial = REGENERABLE_NAMES.has(sc.name) || sc.sizeBytes === 0 || sc.empty === true;
      if (trivial) {
        if (idle !== null && idle >= scratchTtl) act(OPS.remove, sc.path, "non-task-empty-or-regenerable");
        continue;
      }
      hold(sc, "non-task");
      if (underPressure && !NEVER_REAP_NAMES.has(sc.name)) act(OPS.archiveRemove, sc.path, "non-task-pressure-idle");
      continue;
    }

    // /scratch (and the scratch roots under the hermes volume): the plain TTL
    if (idle === null || idle < scratchTtl) continue;
    const big = typeof sc.sizeBytes === "number" && sc.sizeBytes > MIB;
    if ((sc.isGit || hasNested) && unsafe) {
      act(OPS.archiveRemove, sc.path, "scratch-ttl-unpushed", sc.name);
    } else if (!sc.isGit && (hasNested || big)) {
      act(OPS.archiveRemove, sc.path, "scratch-ttl-data", sc.name);
    } else {
      act(OPS.remove, sc.path, "scratch-ttl", sc.name);
    }
  }

  // --- class D: bases -----------------------------------------------------
  const bases = arr(inv.bases);
  const doomedBases = new Set();
  for (const b of bases) {
    const used = toMs(b.lastUsedAt);
    if (b.localOnlyRefs === 0 && (b.worktreeCount ?? 0) === 0 && used !== null && nowMs - used >= lim.baseIdleMs) {
      doomedBases.add(b.path);
      act(OPS.deleteBase, b.path, "base-idle-30d");
    }
  }
  // Over the limit: oldest by use first, but only a base nobody works in.
  const kept = bases.filter((b) => !doomedBases.has(b.path));
  let excess = kept.length - lim.baseLimit;
  if (excess > 0) {
    const candidates = kept
      .filter((b) => b.localOnlyRefs === 0 && (b.worktreeCount ?? 0) === 0)
      .sort((a, b) => (toMs(a.lastUsedAt) ?? 0) - (toMs(b.lastUsedAt) ?? 0));
    for (const b of candidates) {
      if (excess <= 0) break;
      act(OPS.deleteBase, b.path, "base-over-limit");
      excess -= 1;
    }
  }

  // --- class F: archives --------------------------------------------------
  const archives = [...arr(inv.archives)].sort(
    (a, b) => (toMs(a.createdAt) ?? 0) - (toMs(b.createdAt) ?? 0), // oldest first
  );
  const archiveMaxAge = pressed ? lim.archivePressureAgeMs : lim.archiveMaxAgeMs;
  const survivors = [];
  for (const a of archives) {
    const created = toMs(a.createdAt);
    if (created !== null && nowMs - created >= archiveMaxAge) {
      act(OPS.deleteArchive, a.path, pressed ? "archive-pressure-7d" : "archive-30d");
    } else {
      survivors.push(a);
    }
  }
  let total = survivors.reduce((n, a) => n + (a.sizeBytes ?? 0), 0);
  for (const a of survivors) {
    if (total <= lim.archiveCapBytes) break;
    act(OPS.deleteArchive, a.path, "archive-over-cap");
    total -= a.sizeBytes ?? 0;
  }

  // Last line of defence: nothing may touch the copy of an active task.
  const safe = actions.filter((a) => !activePaths.has(a.path) || a.op === OPS.prune);
  return { actions: safe, held, pressure, blockOpen: pressure === "hard" };
}

/** decide(inventory, desired, now, settings) -> actions[] (data only). */
export function decide(inventory, desired, now, settings) {
  return plan(inventory, desired, now, settings).actions;
}
