import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.5 BOT-DISK-H3b): the botd decision function (design section 2.3)
// is pure, so every row of the table is a plain data case. Placeholder keys and
// repositories only.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { decide, plan, toMs, taskKeyOf, OPS } = await import(path.join(ROOT, "docker/bot-runtime/botd/lib/rules.js"));
const FIXTURES = path.join(ROOT, "docs/myrmidon/bot-disk-contract");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));

const NOW = Date.parse("2026-10-06T15:00:00Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GIB = 1024 ** 3;
const ago = (ms) => new Date(NOW - ms).toISOString();

function desired({ workspaces = [], level = "none", grace } = {}) {
  return {
    generatedAt: ago(0),
    grace: { closingMinutes: 30, scratchTtlHours: 24, orphanHours: 24, ...grace },
    pressure: { quotaPercent: null, partitionPercent: 50, level },
    workspaces,
  };
}
const ws = (key, state, sinceMs, prState = "none") => ({
  key,
  repo: "acme/widgets",
  state,
  since: ago(sinceMs),
  prState,
  branch: `bot/${key}`,
});
const wt = (key, over = {}) => ({
  key,
  path: `/workspace/${key}`,
  clean: true,
  pushed: true,
  openedAt: ago(2 * HOUR),
  ...over,
});
const ops = (actions) => actions.map((a) => [a.op, a.path]);

describe("botd rules: class E worktrees (table of section 2.3)", () => {
  const rows = [
    // [name, ws state, minutes in state, prState, clean, pushed, expected op | null]
    ["active, clean+pushed: nothing", "active", 600, "open", true, true, null],
    ["active, dirty+unpushed: nothing", "active", 600, "open", false, false, null],
    ["active even with merged PR: nothing", "active", 600, "merged", true, true, null],
    ["closing 29 min: inside grace", "closing", 29, "open", true, true, null],
    ["closing 30 min, clean+pushed: remove", "closing", 30, "open", true, true, OPS.remove],
    ["closing 31 min, clean+pushed: remove", "closing", 31, "open", true, true, OPS.remove],
    ["closing 31 min, dirty: archive+remove", "closing", 31, "open", false, true, OPS.archiveRemove],
    ["closing 31 min, unpushed: archive+remove", "closing", 31, "open", true, false, OPS.archiveRemove],
    ["closing 31 min, closed PR, unpushed: archive+remove", "closing", 31, "closed", true, false, OPS.archiveRemove],
    ["closing 31 min, no PR, dirty+unpushed: archive+remove", "closing", 31, "none", false, false, OPS.archiveRemove],
    ["merged, clean+pushed: remove", "closing", 31, "merged", true, true, OPS.remove],
    ["merged, dirty: archive+remove (edits after merge are not delivered)", "closing", 31, "merged", false, true, OPS.archiveRemove],
    ["merged, unpushed commits after merge: archive+remove", "closing", 31, "merged", true, false, OPS.archiveRemove],
    ["merged, dirty+unpushed: archive+remove", "closing", 31, "merged", false, false, OPS.archiveRemove],
    ["merged but inside grace: nothing", "closing", 29, "merged", true, false, null],
  ];
  for (const [name, state, minutes, prState, clean, pushed, expected] of rows) {
    it(name, () => {
      const d = desired({ workspaces: [ws("ABC-1", state, minutes * MIN, prState)] });
      const out = decide({ worktrees: [wt("ABC-1", { clean, pushed })] }, d, NOW);
      if (expected === null) assert.deepEqual(out, []);
      else assert.deepEqual(ops(out), [[expected, "/workspace/ABC-1"]]);
    });
  }

  it("grace boundary is taken from the board (desired.grace), not hard-coded", () => {
    const d = desired({ workspaces: [ws("ABC-1", "closing", 40 * MIN)], grace: { closingMinutes: 45 } });
    assert.deepEqual(decide({ worktrees: [wt("ABC-1")] }, d, NOW), []);
  });

  it("falls back to settings.graceClosingMinutes when the board sends no grace", () => {
    const d = { ...desired({ workspaces: [ws("ABC-1", "closing", 40 * MIN)] }), grace: undefined };
    assert.deepEqual(decide({ worktrees: [wt("ABC-1")] }, d, NOW, { graceClosingMinutes: 45 }), []);
    assert.equal(decide({ worktrees: [wt("ABC-1")] }, d, NOW, { graceClosingMinutes: 40 }).length, 1);
  });

  it("active drift (directory gone): prune, never remove", () => {
    const d = desired({ workspaces: [ws("ABC-1", "active", HOUR, "open")] });
    const out = decide({ worktrees: [wt("ABC-1", { dirMissing: true })] }, d, NOW);
    assert.deepEqual(ops(out), [[OPS.prune, "/workspace/ABC-1"]]);
  });

  it("closing with a missing directory: prune after grace", () => {
    const d = desired({ workspaces: [ws("ABC-1", "closing", 31 * MIN)] });
    const out = decide({ worktrees: [wt("ABC-1", { dirMissing: true })] }, d, NOW);
    assert.deepEqual(ops(out), [[OPS.prune, "/workspace/ABC-1"]]);
  });

  it("absent from the list: orphan grace 24 h from openedAt", () => {
    const d = desired();
    const fresh = wt("ZZZ-9", { openedAt: ago(23 * HOUR + 59 * MIN) });
    const old = wt("ZZZ-8", { openedAt: ago(24 * HOUR) });
    assert.deepEqual(decide({ worktrees: [fresh] }, d, NOW), []);
    assert.deepEqual(ops(decide({ worktrees: [old] }, d, NOW)), [[OPS.remove, "/workspace/ZZZ-8"]]);
  });

  it("orphan with unpushed work is archived first", () => {
    const old = wt("ZZZ-8", { openedAt: ago(25 * HOUR), pushed: false });
    assert.deepEqual(ops(decide({ worktrees: [old] }, desired(), NOW)), [[OPS.archiveRemove, "/workspace/ZZZ-8"]]);
  });

  it("merged with null/undefined clean or pushed is unsafe: archive, never remove", () => {
    const d = desired({ workspaces: [ws("ABC-1", "closing", HOUR, "merged")] });
    for (const over of [{ clean: null }, { pushed: null }, { clean: undefined }, { pushed: undefined }, { clean: null, pushed: null }]) {
      const out = decide({ worktrees: [wt("ABC-1", over)] }, d, NOW);
      assert.deepEqual(ops(out), [[OPS.archiveRemove, "/workspace/ABC-1"]], JSON.stringify(over));
    }
    const noFacts = { key: "ABC-1", path: "/workspace/ABC-1", openedAt: ago(2 * HOUR) };
    assert.deepEqual(ops(decide({ worktrees: [noFacts] }, d, NOW)), [[OPS.archiveRemove, "/workspace/ABC-1"]]);
  });

  it("merged orphan-less safety: the property sweep never yields plain remove for a dirty/unpushed copy", () => {
    for (const prState of ["none", "open", "merged", "closed"])
      for (const clean of [true, false, null, undefined])
        for (const pushed of [true, false, null, undefined]) {
          const d = desired({ workspaces: [ws("ABC-1", "closing", HOUR, prState)] });
          const out = decide({ worktrees: [wt("ABC-1", { clean, pushed })] }, d, NOW);
          const safe = clean === true && pushed === true;
          assert.equal(out[0].op, safe ? OPS.remove : OPS.archiveRemove, `${prState} ${clean} ${pushed}`);
        }
  });

  it("unknown cleanliness counts as unsafe (archive first)", () => {
    const d = desired({ workspaces: [ws("ABC-1", "closing", HOUR)] });
    const out = decide({ worktrees: [{ key: "ABC-1", path: "/workspace/ABC-1", openedAt: ago(HOUR) }] }, d, NOW);
    assert.equal(out[0].op, OPS.archiveRemove);
  });

  it("every action carries op, path and a reason", () => {
    const d = desired({ workspaces: [ws("ABC-1", "closing", HOUR)] });
    const [a] = decide({ worktrees: [wt("ABC-1")] }, d, NOW);
    assert.equal(typeof a.reason, "string");
    assert.ok(a.reason.length > 0);
    assert.ok(Object.values(OPS).includes(a.op));
  });
});

describe("botd rules: pressure", () => {
  it("soft: closing grace 0 (a minute-old closing copy goes)", () => {
    const d = desired({ workspaces: [ws("ABC-1", "closing", MIN)], level: "soft" });
    assert.deepEqual(ops(decide({ worktrees: [wt("ABC-1")] }, d, NOW)), [[OPS.remove, "/workspace/ABC-1"]]);
  });

  it("none: the same copy waits", () => {
    const d = desired({ workspaces: [ws("ABC-1", "closing", MIN)] });
    assert.deepEqual(decide({ worktrees: [wt("ABC-1")] }, d, NOW), []);
  });

  it("soft: unpushed closing copy is still archived, not dropped", () => {
    const d = desired({ workspaces: [ws("ABC-1", "closing", MIN)], level: "soft" });
    const out = decide({ worktrees: [wt("ABC-1", { pushed: false })] }, d, NOW);
    assert.equal(out[0].op, OPS.archiveRemove);
  });

  it("soft: scratch TTL 1 h", () => {
    const sc = (name, age) => ({ name, path: `/scratch/${name}`, mtime: ago(age), isGit: false });
    const inv = { scratch: [sc("a", 59 * MIN), sc("b", HOUR), sc("c", 2 * HOUR)] };
    assert.deepEqual(decide(inv, desired({ level: "soft" }), NOW).map((x) => x.path), ["/scratch/b", "/scratch/c"]);
    assert.deepEqual(decide(inv, desired(), NOW), []);
  });

  it("soft: archives older than 7 days go; none: they stay until 30 days", () => {
    const inv = {
      archives: [
        { path: "/a/new", createdAt: ago(6 * DAY), sizeBytes: 1 },
        { path: "/a/week", createdAt: ago(7 * DAY), sizeBytes: 1 },
        { path: "/a/month", createdAt: ago(30 * DAY), sizeBytes: 1 },
      ],
    };
    assert.deepEqual(decide(inv, desired({ level: "soft" }), NOW).map((x) => x.path), ["/a/month", "/a/week"]);
    assert.deepEqual(decide(inv, desired(), NOW).map((x) => x.path), ["/a/month"]);
  });

  it("hard: same cleanup as soft plus blockOpen", () => {
    const d = (level) => desired({ workspaces: [ws("ABC-1", "closing", MIN)], level });
    const inv = { worktrees: [wt("ABC-1")] };
    assert.deepEqual(decide(inv, d("hard"), NOW), decide(inv, d("soft"), NOW));
    assert.equal(plan(inv, d("hard"), NOW).blockOpen, true);
    assert.equal(plan(inv, d("soft"), NOW).blockOpen, false);
    assert.equal(plan(inv, d("none"), NOW).blockOpen, false);
    assert.equal(plan(inv, d("hard"), NOW).pressure, "hard");
  });
});

describe("botd rules: class G scratch", () => {
  const sc = (over) => ({ name: "probe", path: "/scratch/probe", mtime: ago(25 * HOUR), isGit: false, ...over });

  it("younger than TTL: kept; 24 h: removed", () => {
    assert.deepEqual(decide({ scratch: [sc({ mtime: ago(23 * HOUR) })] }, desired(), NOW), []);
    assert.deepEqual(ops(decide({ scratch: [sc({ mtime: ago(24 * HOUR) })] }, desired(), NOW)), [[OPS.remove, "/scratch/probe"]]);
  });

  it("git scratch with unpushed work: archive first", () => {
    const out = decide({ scratch: [sc({ isGit: true, clean: false, pushed: false })], run: { live: false } }, desired(), NOW);
    assert.deepEqual(ops(out), [[OPS.archiveRemove, "/scratch/probe"]]);
  });

  it("git scratch clean+pushed: plain remove", () => {
    const out = decide({ scratch: [sc({ isGit: true, clean: true, pushed: true })] }, desired(), NOW);
    assert.deepEqual(ops(out), [[OPS.remove, "/scratch/probe"]]);
  });

  it("scratch named like an active task is left alone", () => {
    const d = desired({ workspaces: [ws("ABC-1", "active", HOUR, "open")] });
    assert.deepEqual(decide({ scratch: [sc({ name: "ABC-1", path: "/scratch/ABC-1" })] }, d, NOW), []);
  });
});

describe("botd rules: class D bases", () => {
  const base = (n, over = {}) => ({
    path: `/git-base/acme/r${n}.git`,
    repo: `acme/r${n}`,
    worktreeCount: 0,
    localOnlyRefs: 0,
    lastUsedAt: ago(DAY),
    ...over,
  });

  it("no worktree for 30 days: delete-base (29 days: kept)", () => {
    const inv = { bases: [base(1, { lastUsedAt: ago(30 * DAY) }), base(2, { lastUsedAt: ago(29 * DAY) })] };
    assert.deepEqual(ops(decide(inv, desired(), NOW)), [[OPS.deleteBase, "/git-base/acme/r1.git"]]);
  });

  it("a base with a live worktree is never idle-deleted", () => {
    const inv = { bases: [base(1, { lastUsedAt: ago(90 * DAY), worktreeCount: 1 })] };
    assert.deepEqual(decide(inv, desired(), NOW), []);
  });

  it("a base with local-only branches (not on origin) is never deleted: idle or over the limit", () => {
    for (const localOnlyRefs of [1, 3, null, undefined]) {
      const idle = { bases: [base(1, { lastUsedAt: ago(90 * DAY), localOnlyRefs })] };
      assert.deepEqual(decide(idle, desired(), NOW), [], String(localOnlyRefs));
    }
    const bases = Array.from({ length: 9 }, (_, i) =>
      base(i, { lastUsedAt: ago((i + 1) * DAY), localOnlyRefs: i === 8 ? 2 : 0 }),
    );
    // r8 is the oldest but holds local-only work: the next oldest (r7) goes
    assert.deepEqual(ops(decide({ bases }, desired(), NOW)), [[OPS.deleteBase, "/git-base/acme/r7.git"]]);
  });

  it("limit 8: nine bases -> the oldest goes", () => {
    const bases = Array.from({ length: 9 }, (_, i) => base(i, { lastUsedAt: ago((i + 1) * DAY) }));
    // r8 is the oldest (9 days)
    assert.deepEqual(ops(decide({ bases }, desired(), NOW)), [[OPS.deleteBase, "/git-base/acme/r8.git"]]);
  });

  it("limit 8: exactly eight bases -> nothing", () => {
    const bases = Array.from({ length: 8 }, (_, i) => base(i, { lastUsedAt: ago((i + 1) * DAY) }));
    assert.deepEqual(decide({ bases }, desired(), NOW), []);
  });

  it("limit 8: skips bases that still hold worktrees", () => {
    const bases = Array.from({ length: 9 }, (_, i) =>
      base(i, { lastUsedAt: ago((i + 1) * DAY), worktreeCount: i === 8 ? 2 : 0 }),
    );
    // r8 is the oldest but busy: the next oldest idle one (r7) goes
    assert.deepEqual(ops(decide({ bases }, desired(), NOW)), [[OPS.deleteBase, "/git-base/acme/r7.git"]]);
  });

  it("an idle-expired base counts against the limit only once", () => {
    const bases = [
      ...Array.from({ length: 8 }, (_, i) => base(i, { lastUsedAt: ago((i + 1) * DAY) })),
      base(99, { lastUsedAt: ago(40 * DAY) }),
    ];
    assert.deepEqual(ops(decide({ bases }, desired(), NOW)), [[OPS.deleteBase, "/git-base/acme/r99.git"]]);
  });
});

describe("botd rules: class F archives", () => {
  it("over the 2 GiB cap: oldest first until under it", () => {
    const inv = {
      archives: [
        { path: "/a/3", createdAt: ago(3 * DAY), sizeBytes: 1 * GIB },
        { path: "/a/1", createdAt: ago(1 * DAY), sizeBytes: 1 * GIB },
        { path: "/a/2", createdAt: ago(2 * DAY), sizeBytes: 1 * GIB },
      ],
    };
    assert.deepEqual(ops(decide(inv, desired(), NOW)), [[OPS.deleteArchive, "/a/3"]]);
  });

  it("30 days old: deleted", () => {
    const inv = { archives: [{ path: "/a/old", createdAt: ago(31 * DAY), sizeBytes: 5 }] };
    assert.deepEqual(ops(decide(inv, desired(), NOW)), [[OPS.deleteArchive, "/a/old"]]);
  });
});

describe("botd rules: safety", () => {
  it("fail-safe: no desired state deletes nothing", () => {
    const inv = { worktrees: [wt("ABC-1", { openedAt: ago(90 * DAY) })], scratch: [{ name: "x", path: "/scratch/x", mtime: ago(90 * DAY) }] };
    assert.deepEqual(decide(inv, null, NOW), []);
    assert.deepEqual(decide(inv, undefined, NOW), []);
    assert.deepEqual(decide(inv, {}, NOW), []);
    assert.deepEqual(decide(inv, { workspaces: "nope" }, NOW), []);
  });

  it("empty or missing inventory yields no actions", () => {
    assert.deepEqual(decide({}, desired(), NOW), []);
    assert.deepEqual(decide(undefined, desired(), NOW), []);
  });

  it("foreign-shaped inventory (classifier output: items/actions) deletes nothing and does not throw", () => {
    const d = desired({ workspaces: [ws("ABC-1", "closing", HOUR, "merged")] });
    const foreign = { items: [{ path: "/workspace/ABC-1", ageSec: 99999 }], actions: [{ op: "remove" }] };
    assert.deepEqual(decide(foreign, d, NOW), []);
    assert.deepEqual(decide({ worktrees: "x", scratch: {}, bases: null, archives: 5 }, d, NOW), []);
  });

  it("is pure: inputs are not mutated and repeated calls agree", () => {
    const d = desired({ workspaces: [ws("ABC-1", "closing", HOUR, "merged")], level: "soft" });
    const inv = { worktrees: [wt("ABC-1")], archives: [{ path: "/a/1", createdAt: ago(9 * DAY), sizeBytes: 1 }] };
    const before = JSON.stringify([inv, d]);
    const first = decide(inv, d, NOW);
    assert.deepEqual(decide(inv, d, NOW), first);
    assert.equal(JSON.stringify([inv, d]), before);
  });

  it("accepts now as a Date-like ISO string or epoch ms", () => {
    const d = desired({ workspaces: [ws("ABC-1", "closing", HOUR)] });
    const inv = { worktrees: [wt("ABC-1")] };
    assert.deepEqual(decide(inv, d, new Date(NOW).toISOString()), decide(inv, d, NOW));
  });

  it("no action deletes a copy of an active task, whatever else is in the inventory (property sweep)", () => {
    const states = ["active", "closing"];
    const prs = ["none", "open", "merged", "closed"];
    const levels = ["none", "soft", "hard"];
    let checked = 0;
    for (const state of states)
      for (const prState of prs)
        for (const level of levels)
          for (const clean of [true, false])
            for (const pushed of [true, false])
              for (const minutes of [0, 29, 30, 31, 100000]) {
                const d = desired({ workspaces: [ws("ABC-1", state, minutes * MIN, prState)], level });
                const inv = {
                  worktrees: [wt("ABC-1", { clean, pushed })],
                  scratch: [{ name: "ABC-1", path: "/scratch/ABC-1", mtime: ago(90 * DAY), isGit: false }],
                };
                const out = decide(inv, d, NOW);
                if (state === "active") {
                  for (const a of out) {
                    assert.ok(![OPS.remove, OPS.archiveRemove].includes(a.op), JSON.stringify(a));
                  }
                  assert.deepEqual(out, []);
                  checked += 1;
                }
              }
    assert.ok(checked > 100);
  });
});

describe("botd rules: contract fixtures", () => {
  it("desired-state.json has the C3 shape and drives the function", () => {
    const d = fixture("desired-state.json");
    assert.deepEqual(Object.keys(d).sort(), ["closedKeys", "generatedAt", "grace", "pressure", "protectKeys", "workspaces"]);
    assert.deepEqual(Object.keys(d.grace).sort(), ["closingMinutes", "orphanHours", "scratchTtlHours"]);
    assert.ok(["none", "soft", "hard"].includes(d.pressure.level));
    for (const w of d.workspaces) {
      assert.ok(["active", "closing"].includes(w.state));
      assert.ok(["none", "open", "merged", "closed"].includes(w.prState));
      assert.ok(!Number.isNaN(Date.parse(w.since)));
    }
    // The registry fixture lists ABC-101 (active) next to the closing ABC-099.
    const now = Date.parse(d.generatedAt);
    const inv = {
      worktrees: [
        { key: "ABC-101", path: "/workspace/ABC-101", clean: false, pushed: false, openedAt: d.workspaces[0].since },
        { key: "ABC-099", path: "/workspace/ABC-099", clean: true, pushed: false, openedAt: d.workspaces[1].since },
      ],
    };
    // ABC-099 closed 26 min before generatedAt: still in grace.
    assert.deepEqual(decide(inv, d, now), []);
    // 4 minutes later it passes 30 min; merged but pushed=false -> archive first, ABC-101 untouched.
    const later = decide(inv, d, now + 4 * MIN);
    assert.deepEqual(ops(later), [[OPS.archiveRemove, "/workspace/ABC-099"]]);
    // The same copy clean and pushed goes without an archive.
    inv.worktrees[1].pushed = true;
    assert.deepEqual(ops(decide(inv, d, now + 4 * MIN)), [[OPS.remove, "/workspace/ABC-099"]]);
  });

  it("pressure of the fixture and of disk-state.json use the same level names", () => {
    assert.equal(fixture("desired-state.json").pressure.level, fixture("disk-state.json").pressure);
  });

  it("botdisk-settings.json keys feed the function without changing defaults", () => {
    const s = fixture("botdisk-settings.json");
    const d = desired({ workspaces: [ws("ABC-1", "closing", 31 * MIN)] });
    assert.equal(decide({ worktrees: [wt("ABC-1")] }, d, NOW, s).length, 1);
  });
});

describe("botd rules: toMs", () => {
  it("understands a Date, epoch ms and an ISO string; rejects the rest", () => {
    assert.equal(toMs(new Date(NOW)), NOW);
    assert.equal(toMs(NOW), NOW);
    assert.equal(toMs("2026-10-06T15:00:00Z"), NOW);
    assert.equal(toMs(new Date("nope")), null);
    assert.equal(toMs(undefined), null);
    assert.equal(toMs({}), null);
  });

  it("plan() with a Date clock is not empty on a stale scratch copy", () => {
    const inv = { scratch: [{ name: "x", path: "/scratch/x", mtime: ago(48 * HOUR), isGit: false }] };
    assert.deepEqual(ops(plan(inv, desired(), new Date(NOW)).actions), [[OPS.remove, "/scratch/x"]]);
  });
});

describe("botd rules: taskKeyOf", () => {
  it("normalizes case, prefixes and tails to PREFIX-N", () => {
    for (const [name, key] of [
      ["OPE-3873", "OPE-3873"],
      ["ope-3873", "OPE-3873"],
      ["ope3282v2", "OPE-3282"],
      ["scratch-ope3213", "OPE-3213"],
      [".trash-OPE-4331", "OPE-4331"],
      ["OPE-4915-stale-rootowned", "OPE-4915"],
      ["ABC-099", "ABC-099"],
    ]) assert.equal(taskKeyOf(name), key, name);
    for (const name of ["shared", "tmp", "work", "srv-dev", "OPE-board-db-audit", "foot-measure", "", null]) {
      assert.equal(taskKeyOf(name), null, String(name));
    }
  });
});

describe("botd rules: directories under /workspace by the board's word (policy table, section 2)", () => {
  const dir = (name, over = {}) => ({ name, path: `/workspace/${name}`, mtime: ago(48 * HOUR), isGit: true, clean: null, pushed: null, nestedGit: [], sizeBytes: 5 * GIB, ...over });
  const d = (over = {}) => ({ ...desired({ level: over.level ?? "none" }), protectKeys: [], closedKeys: [], ...over });
  const run = (sc, desiredState) => plan({ scratch: [sc], run: { live: false } }, desiredState, NOW);

  it("open task of THIS bot (protectKeys): kept, reported legacy-open, in any case and spelling", () => {
    for (const name of ["OPE-3873", "ope-3873", "ope3873v2"]) {
      const out = run(dir(name), d({ protectKeys: ["OPE-3873"], closedKeys: ["OPE-3873"] }));
      assert.deepEqual(out.actions, [], name);
      assert.deepEqual(out.held.map((h) => h.kind), ["legacy-open"], name);
    }
    assert.deepEqual(run(dir("OPE-3873"), d({ protectKeys: ["OPE-3873"], level: "hard" })).actions, []);
  });

  it("open task at ANOTHER bot (listed by the board, not closed): kept and reported, whatever the age", () => {
    const state = d({ workspaces: [ws("OPE-4954", "closing", 2 * DAY, "open")] });
    const out = run(dir("OPE-4954", { mtime: ago(90 * DAY) }), state);
    assert.deepEqual(out.actions, []);
    assert.deepEqual(out.held.map((h) => h.kind), ["legacy-open-elsewhere"]);
  });

  it("open task elsewhere under HARD pressure: archived only after the idle days", () => {
    const state = d({ level: "hard", workspaces: [ws("OPE-4954", "closing", 2 * DAY, "open")] });
    assert.deepEqual(run(dir("OPE-4954", { mtime: ago(3 * DAY) }), state).actions, []);
    assert.deepEqual(ops(run(dir("OPE-4954", { mtime: ago(8 * DAY) }), state).actions), [[OPS.archiveRemove, "/workspace/OPE-4954"]]);
  });

  it("closed task (closedKeys): archive-remove, also for case/suffix variants, a nested repository, a clean+pushed one", () => {
    for (const name of ["OPE-4954", "ope-4954", "ope4954v2", "scratch-ope4954", "OPE-4954-stale-rootowned"]) {
      const out = run(dir(name), d({ closedKeys: ["OPE-4954"] }));
      assert.deepEqual(ops(out.actions), [[OPS.archiveRemove, `/workspace/${name}`]], name);
    }
    const nested = dir("OPE-4954", { isGit: true, nestedGit: ["/workspace/OPE-4954/repo"], clean: true, pushed: true });
    assert.equal(run(nested, d({ closedKeys: ["OPE-4954"] })).actions[0].op, OPS.archiveRemove);
  });

  it("closed task inside the grace is left; under pressure the grace is 0", () => {
    const fresh = dir("OPE-4954", { mtime: ago(10 * MIN) });
    assert.deepEqual(run(fresh, d({ closedKeys: ["OPE-4954"] })).actions, []);
    assert.equal(run(fresh, d({ closedKeys: ["OPE-4954"], level: "soft" })).actions.length, 1);
  });

  it("a key the board does not know (nobody's list): kept, reported unknown-key", () => {
    const out = run(dir("ope-4022"), d({ closedKeys: ["OPE-1"], protectKeys: ["OPE-2"] }));
    assert.deepEqual(out.actions, []);
    assert.deepEqual(out.held.map((h) => h.kind), ["unknown-key"]);
  });

  it("an older board without closedKeys: nothing under /workspace is removed", () => {
    const old = { ...desired(), protectKeys: [] };
    assert.deepEqual(run(dir("OPE-4954"), old).actions, []);
  });

  it("no task behind the name (shared, tmp, work, srv-dev): reported, nothing removed at none/soft", () => {
    for (const name of ["shared", "tmp", "work", "srv-dev"]) {
      for (const level of ["none", "soft"]) {
        const out = run(dir(name, { nestedGit: name === "srv-dev" ? ["/workspace/srv-dev/a", "/workspace/srv-dev/b"] : [] }), d({ level }));
        assert.deepEqual(out.actions, [], `${name} ${level}`);
        assert.deepEqual(out.held.map((h) => h.kind), ["non-task"], `${name} ${level}`);
      }
    }
  });

  it("no task: hard pressure archives an idle srv-dev after 7 days, never shared", () => {
    const hard = d({ level: "hard" });
    const srv = dir("srv-dev", { mtime: ago(8 * DAY), nestedGit: ["/workspace/srv-dev/a"] });
    assert.deepEqual(ops(run(srv, hard).actions), [[OPS.archiveRemove, "/workspace/srv-dev"]]);
    assert.deepEqual(run({ ...srv, mtime: ago(2 * DAY) }, hard).actions, []);
    assert.deepEqual(run(dir("shared", { mtime: ago(90 * DAY) }), hard).actions, []);
  });

  it("legacyPressureIdleDays from desired.grace overrides the 7 days", () => {
    const hard = d({ level: "hard", grace: { legacyPressureIdleDays: 2 } });
    assert.equal(run(dir("srv-dev", { mtime: ago(3 * DAY) }), hard).actions.length, 1);
  });

  it("no task, empty or regenerable: removed once idle, no archive", () => {
    const empty = dir("OPE-board-db-audit", { sizeBytes: 0, isGit: false });
    assert.deepEqual(ops(run(empty, d()).actions), [[OPS.remove, "/workspace/OPE-board-db-audit"]]);
    const nm = dir("node_modules", { isGit: false });
    assert.deepEqual(ops(run(nm, d()).actions), [[OPS.remove, "/workspace/node_modules"]]);
    assert.deepEqual(run({ ...empty, mtime: ago(HOUR) }, d()).actions, []);
  });

  it("the copy of an active task is never touched, by path or by normalized key", () => {
    const state = d({ workspaces: [ws("OPE-7", "active", HOUR, "open")], closedKeys: ["OPE-7"] });
    assert.deepEqual(run(dir("ope-7"), state).actions, []);
  });
});

describe("botd rules: /scratch keeps the TTL", () => {
  const sc = (over = {}) => ({ name: "probe", path: "/scratch/probe", mtime: ago(48 * HOUR), isGit: false, nestedGit: [], ...over });
  it("a key-like name in /scratch is judged by the TTL, not by the board", () => {
    assert.deepEqual(ops(plan({ scratch: [sc({ name: "OPE-4954", path: "/scratch/OPE-4954" })] }, { ...desired(), protectKeys: [], closedKeys: [] }, NOW).actions), [[OPS.remove, "/scratch/OPE-4954"]]);
  });
  it("git or nested repositories with unknown state are archived, not just removed", () => {
    const idle = { run: { live: false } };
    assert.equal(plan({ scratch: [sc({ isGit: true })], ...idle }, desired(), NOW).actions[0].op, OPS.archiveRemove);
    assert.equal(plan({ scratch: [sc({ nestedGit: ["/scratch/probe/x"] })], ...idle }, desired(), NOW).actions[0].op, OPS.archiveRemove);
  });
  it("a non-git tree over 1 MiB is archived as a tar; a small one is removed", () => {
    assert.equal(plan({ scratch: [sc({ sizeBytes: 5 * 1024 * 1024 })] }, desired(), NOW).actions[0].op, OPS.archiveRemove);
    assert.equal(plan({ scratch: [sc({ sizeBytes: 100 })] }, desired(), NOW).actions[0].op, OPS.remove);
  });
});

// myrmidon(1.6.5 BOT-DISK-H3f): a repository with unsaved work is never reaped under a bot run.
describe("botd rules: unsafe git is kept while a run is live (or unknown)", () => {
  const git = (over = {}) => ({ name: "repo", path: "/scratch/repo", mtime: ago(2 * HOUR), isGit: true, clean: false, pushed: false, nestedGit: [], ...over });
  const go = (sc, level, run) => plan({ scratch: [sc], ...(run === undefined ? {} : { run }) }, desired({ level }), NOW);
  const LIVE = { live: true };
  const IDLE = { live: false };

  it("live run, dirty git in /scratch, soft: intact and reported", () => {
    const out = go(git(), "soft", LIVE);
    assert.deepEqual(out.actions, []);
    assert.deepEqual(out.held, [{ path: "/scratch/repo", kind: "unsafe-git-live-run" }]);
  });

  it("live run, dirty git in /scratch, hard: intact, even idle for 25 h", () => {
    for (const mtime of [ago(2 * HOUR), ago(25 * HOUR), ago(90 * DAY)]) {
      const out = go(git({ mtime }), "hard", LIVE);
      assert.deepEqual(out.actions, []);
      assert.deepEqual(out.held.map((h) => h.kind), ["unsafe-git-live-run"]);
    }
  });

  it("an active task on the board counts as a live run", () => {
    const d = desired({ workspaces: [ws("ABC-1", "active", HOUR, "open")], level: "hard" });
    const out = plan({ scratch: [git({ mtime: ago(90 * DAY) })], run: IDLE }, d, NOW);
    assert.deepEqual(out.actions, []);
    assert.deepEqual(out.held.map((h) => h.kind), ["unsafe-git-live-run"]);
  });

  it("no run, soft, idle 2 h: intact (pressure does not shorten the term)", () => {
    assert.deepEqual(go(git(), "soft", IDLE).actions, []);
    assert.deepEqual(go(git(), "hard", IDLE).actions, []);
    assert.deepEqual(go(git({ mtime: ago(23 * HOUR) }), "hard", IDLE).actions, []);
  });

  it("no run, hard, idle 25 h: archive-remove", () => {
    assert.deepEqual(ops(go(git({ mtime: ago(25 * HOUR) }), "hard", IDLE).actions), [[OPS.archiveRemove, "/scratch/repo"]]);
  });

  it("no run, soft or none, idle 25 h: the 24 h term applies, archive-remove", () => {
    for (const level of ["none", "soft"]) {
      assert.deepEqual(ops(go(git({ mtime: ago(25 * HOUR) }), level, IDLE).actions), [[OPS.archiveRemove, "/scratch/repo"]]);
    }
  });

  it("the term follows scratchTtlHours from the board", () => {
    const d = desired({ level: "hard", grace: { scratchTtlHours: 48 } });
    assert.deepEqual(plan({ scratch: [git({ mtime: ago(25 * HOUR) })], run: IDLE }, d, NOW).actions, []);
  });

  it("clean+pushed git, no run, soft, idle 2 h: the old behaviour (removed on the pressure TTL)", () => {
    assert.deepEqual(ops(go(git({ clean: true, pushed: true }), "soft", IDLE).actions), [[OPS.remove, "/scratch/repo"]]);
    assert.deepEqual(go(git({ clean: true, pushed: true }), "none", IDLE).actions, []);
  });

  it("run state unknown (null, missing, foreign shape): intact, fail-closed", () => {
    for (const run of [{ live: null }, undefined, {}, "yes"]) {
      for (const level of ["none", "soft", "hard"]) {
        const out = go(git({ mtime: ago(90 * DAY) }), level, run);
        assert.deepEqual(out.actions, [], `${JSON.stringify(run)} ${level}`);
        assert.deepEqual(out.held.map((h) => h.kind), ["unsafe-git-run-unknown"]);
      }
    }
  });

  it("nested repositories are covered the same way", () => {
    const sc = git({ isGit: false, nestedGit: ["/scratch/repo/x"], mtime: ago(25 * HOUR) });
    assert.deepEqual(go(sc, "hard", LIVE).actions, []);
    assert.deepEqual(ops(go(sc, "hard", IDLE).actions), [[OPS.archiveRemove, "/scratch/repo"]]);
  });

  it("/workspace non-task git under hard pressure: kept while live, archived when idle", () => {
    const d = { ...desired({ level: "hard" }), protectKeys: [], closedKeys: [] };
    const dir = { name: "work", path: "/workspace/work", mtime: ago(8 * DAY), isGit: true, clean: false, pushed: false, nestedGit: [], sizeBytes: 5 * GIB };
    const live = plan({ scratch: [dir], run: LIVE }, d, NOW);
    assert.deepEqual(live.actions, []);
    assert.deepEqual(live.held.map((h) => h.kind), ["unsafe-git-live-run", "non-task"]);
    assert.deepEqual(plan({ scratch: [dir] }, d, NOW).actions, []);
    assert.deepEqual(ops(plan({ scratch: [dir], run: IDLE }, d, NOW).actions), [[OPS.archiveRemove, "/workspace/work"]]);
  });
});
