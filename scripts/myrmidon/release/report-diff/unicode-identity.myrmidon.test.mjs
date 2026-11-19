import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport } from "../verify-on-prod.mjs";
import { diffReports } from "./diff.mjs";

const nfc = "\u00e9";
const nfd = "e\u0301";
const latin = "A";
const cyrillic = "\u0410";
const astral = "\u{10000}";
const bmp = "\ue000";

function report(ids, blocked = []) {
  return buildReport({
    version: "1.7.0", label: "1.7", generatedAt: "2026-11-17T00:00:00Z",
    health: { status: "ok", version: "1.7.0" },
    tasks: ids.map(identifier => ({ identifier, title: "fixture", status: blocked.includes(identifier) ? "blocked" : "done" })),
  });
}

function expected(added, removed, regressions, previous = true, current = true, status = "changed") {
  return { status, version: { before: "1.7.0", after: "1.7.0" }, added, removed, regressions,
    previous: { verified: previous }, current: { verified: current } };
}

test("NFC and NFD replace rather than match", () => {
  assert.deepEqual(diffReports(report([nfc]), report([nfd])), expected(["e\u0301"], ["\u00e9"], []));
});

test("NFD and NFC coexist as distinct identifiers", () => {
  const a = report([nfc, nfd]);
  assert.deepEqual(diffReports(a, structuredClone(a)), expected([], [], [], true, true, "identical"));
});

test("Cyrillic and Latin lookalikes replace rather than match", () => {
  assert.deepEqual(diffReports(report([latin]), report([cyrillic])), expected(["\u0410"], ["A"], []));
});

test("supplementary identifiers differ by code point", () => {
  assert.deepEqual(diffReports(report(["\u{10000}"]), report(["\u{10001}"])), expected(["\u{10001}"], ["\u{10000}"], []));
});

test("added identifiers are sorted by UTF-16 code units", () => {
  assert.deepEqual(diffReports(report(["anchor"]), report([bmp, cyrillic, nfc, astral, nfd, latin, "anchor"])),
    expected(["A", "e\u0301", "\u00e9", "\u0410", "\u{10000}", "\ue000"], [], []));
});

test("removed identifiers are sorted by UTF-16 code units", () => {
  assert.deepEqual(diffReports(report([bmp, cyrillic, nfc, astral, nfd, latin, "anchor"]), report(["anchor"])),
    expected([], ["A", "e\u0301", "\u00e9", "\u0410", "\u{10000}", "\ue000"], []));
});

test("regression is attributed only to exact NFC identifier", () => {
  assert.deepEqual(diffReports(report([nfc, nfd]), report([nfc, nfd], [nfc])),
    expected([], [], ["\u00e9"], true, false));
});

test("regressions preserve and sort lookalike and supplementary identifiers", () => {
  const ids = [bmp, astral, cyrillic, latin, nfc, nfd];
  assert.deepEqual(diffReports(report(ids), report(ids, ids)),
    expected([], [], ["A", "e\u0301", "\u00e9", "\u0410", "\u{10000}", "\ue000"], true, false));
});

test("CLI retains exact Unicode identities in JSON", () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || join(homedir(), ".cache"), "unicode-diff-"));
  try {
    const before = join(dir, "before.json");
    const after = join(dir, "after.json");
    writeFileSync(before, JSON.stringify(report([nfc, latin, astral])));
    writeFileSync(after, JSON.stringify(report([nfc, nfd, cyrillic, bmp], [nfc])));
    const script = fileURLToPath(new URL("./diff.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, before, after], { cwd: dirname(script), encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), expected(["e\u0301", "\u0410", "\ue000"], ["A", "\u{10000}"], ["\u00e9"], true, false));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
