import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyReleaseFast, MAX_FAST_FILES_PER_PACKAGE as N } from "./select.mjs";

const files = (name, count) => Array.from({ length: count }, (_, i) => `${name}/${i}.test.ts`);
const entry = (name, count) => ({ package: name, files: files(name, count) });
const selection = (...entries) => ({ wholePackages: ["shared"], files: entries });
const fast = () => ({ tier: "fast", reasons: ["affected"], changed: ["src/a.ts"] });
const full = () => ({ tier: "full", reasons: ["shared", "config"], changed: ["src/a.ts"] });
const overReason = (name, count = N + 1) => `${count} ${name} test files import the change (limit ${N})`;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function check(plan, selected, options, expected) {
  const inputs = [plan, selected, options];
  const before = structuredClone(inputs);
  deepFreeze(inputs);
  assert.deepStrictEqual(applyReleaseFast(plan, selected, options), expected);
  assert.deepStrictEqual(inputs, before);
}

describe("applyReleaseFast per-package limit matrix", () => {
  for (const [label, count] of [["N-1", N - 1], ["N", N]]) {
    it(`keeps ${label} selected files fast`, () => {
      const plan = fast();
      const selected = selection(entry("server", count));
      check(plan, selected, {}, { ...plan, selection: selected });
    });
  }
  it("escalates N+1 selected files", () => {
    check(fast(), selection(entry("server", N + 1)), {}, { tier: "full", reasons: [overReason("server")], changed: ["src/a.ts"] });
  });
  it("does not add counts across packages at the limit", () => {
    const plan = fast();
    const selected = selection(entry("server", N), entry("ui", N));
    check(plan, selected, {}, { ...plan, selection: selected });
  });
  it("escalates when only the second package exceeds the limit", () => {
    check(fast(), selection(entry("server", N), entry("ui", N + 1)), {}, { tier: "full", reasons: [overReason("ui")], changed: ["src/a.ts"] });
  });
  it("reports each over-limit package in order", () => {
    check(fast(), selection(entry("server", N + 1), entry("ui", N + 2)), {}, { tier: "full", reasons: [overReason("server"), overReason("ui", N + 2)], changed: ["src/a.ts"] });
  });
  it("lowers full on a release branch within the limit", () => {
    const selected = selection(entry("server", N));
    check(full(), selected, { releaseFast: true }, { tier: "fast", reasons: ["release branch PR: affected tests only (was full: shared; config)"], changed: ["src/a.ts"], selection: selected });
  });
  it("re-escalates lowered full when a package exceeds the limit", () => {
    check(full(), selection(entry("server", N + 1)), { releaseFast: true }, { tier: "full", reasons: [overReason("server")], changed: ["src/a.ts"] });
  });
  it("does not lower forced full", () => {
    const plan = full();
    check(plan, selection(entry("server", 1)), { releaseFast: true, forceFull: true }, plan);
  });
  it("does not lower keepFull", () => {
    const plan = { ...full(), keepFull: true };
    check(plan, selection(entry("server", 1)), { releaseFast: true, prLight: true, directSelection: [] }, plan);
  });
  it("leaves docs unchanged even with release fast", () => {
    const plan = { tier: "docs", reasons: ["docs only"], changed: ["docs/a.md"] };
    check(plan, selection(entry("server", N + 1)), { releaseFast: true }, plan);
  });
  it("leaves ordinary full unchanged without release fast", () => {
    const plan = full();
    check(plan, selection(entry("server", 1)), {}, plan);
  });
  it("falls back to full when prLight lacks direct selection", () => {
    check(fast(), selection(entry("server", N + 1)), { prLight: true }, { tier: "full", reasons: [overReason("server")], changed: ["src/a.ts"] });
  });
  it("falls back to full when forceFull prevents prLight", () => {
    check(fast(), selection(entry("server", N + 1)), { prLight: true, forceFull: true, directSelection: [] }, { tier: "full", reasons: [overReason("server")], changed: ["src/a.ts"] });
  });
  it("removes an over-limit package with empty direct selection and preserves the other package", () => {
    const selected = selection(entry("server", N + 1), entry("ui", 1));
    check(fast(), selected, { prLight: true, directSelection: [] }, {
      tier: "fast", reasons: [`PR light: direct tests only (was full: ${overReason("server")})`], changed: ["src/a.ts"],
      selection: selection(entry("ui", 1)),
      light: { limit: N, packages: [{ package: "server", affected: N + 1, direct: 0, kept: 0, dropped: [] }] },
    });
  });
  it("uses direct files and preserves metadata after lowering and light selection", () => {
    const selected = selection(entry("server", N + 1), entry("ui", 1));
    const direct = [{ package: "server", total: 2, files: ["server/direct.test.ts"], dropped: ["server/dropped.test.ts"] }];
    check(full(), selected, { releaseFast: true, prLight: true, directSelection: direct }, {
      tier: "fast",
      reasons: [`PR light: direct tests only (was full: ${overReason("server")})`, "PR light: affected tests only (was full: shared; config)"],
      changed: ["src/a.ts"],
      selection: { wholePackages: ["shared"], files: [{ package: "server", files: ["server/direct.test.ts"] }, entry("ui", 1)] },
      light: { limit: N, packages: [{ package: "server", affected: N + 1, direct: 2, kept: 1, dropped: ["server/dropped.test.ts"] }] },
    });
  });
});
