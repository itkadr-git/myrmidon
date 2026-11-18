import assert from "node:assert/strict";
import { test } from "node:test";
import { newSplitState, runDelta } from "./split-banks.mjs";

const SOURCE = "source";
const T0 = "2026-09-29T00:00:00.000Z";
const BEFORE = "2026-09-28T23:59:59.999Z";
const AFTER = "2026-09-29T00:00:00.001Z";
const MAP = { byAgentIdentity: { foreign: "other" }, byAgentId: {}, byOperatorTag: {}, byDomainTag: {} };
const doc = (id, updatedAt, meta = {}) => ({ id, updatedAt, meta, units: { world: 0, experience: 0 }, textSha256: "synthetic" });

async function exercise({ docs = [], known = [], map = MAP, since, expected, error }) {
  const state = newSplitState(SOURCE, T0);
  state.classifications = known.map(([documentId, targetBank]) => ({ documentId, targetBank, rule: "no_author" }));
  state.copied.push("previous");
  state.verifiedAt = T0;
  const original = structuredClone(state);
  let calls = 0;
  let checkpoints = 0;
  const forbidden = () => { calls += 1; throw new Error("unexpected transport I/O"); };
  const transport = { request: forbidden, upload: forbidden, download: forbidden };
  const opts = { dryRun: true, checkpoint: () => { checkpoints += 1; throw new Error("unexpected checkpoint"); } };
  if (since !== undefined) opts.since = since;
  try {
    const operation = runDelta(transport, state, docs, map, {}, opts);
    if (error) await assert.rejects(operation, error);
    else assert.deepEqual(await operation, { step: "delta (dry-run)", counts: { updatedSince: expected[0], newlyClassified: expected[1], documentsMoved: 0, documentsPending: expected[2] }, documentIds: [] });
  } finally {
    assert.deepEqual(state, original);
    assert.equal(calls, 0);
    assert.equal(checkpoints, 0);
  }
}

const cases = [
  ["one millisecond before t0 is excluded", { docs: [doc("d", BEFORE)], known: [["d", "other"]], expected: [0, 0, 0] }],
  ["exactly t0 is included", { docs: [doc("d", T0)], known: [["d", "other"]], expected: [1, 0, 1] }],
  ["one millisecond after t0 is included", { docs: [doc("d", AFTER)], known: [["d", "other"]], expected: [1, 0, 1] }],
  ["timezone offset represents the same inclusive instant", { docs: [doc("d", "2026-09-29T03:00:00.000+03:00")], known: [["d", "other"]], expected: [1, 0, 1] }],
  ["explicit later since overrides state t0", { docs: [doc("d", T0)], known: [["d", "other"]], since: AFTER, expected: [0, 0, 0] }],
  ["explicit earlier since overrides state t0", { docs: [doc("d", BEFORE)], known: [["d", "other"]], since: BEFORE, expected: [1, 0, 1] }],
  ["invalid since fails before I/O", { docs: [doc("d", T0)], known: [["d", "other"]], since: "invalid", error: /timestamp.*not a valid ISO date/ }],
  ["invalid timestamp on a known own document fails before I/O", { docs: [doc("own", "invalid")], known: [["own", SOURCE]], error: /no valid updatedAt: own/ }],
  ["invalid timestamp is rejected even alongside an older document", { docs: [doc("old", BEFORE), doc("bad", "invalid")], known: [["old", SOURCE], ["bad", SOURCE]], error: /no valid updatedAt: bad/ }],
  ["new foreign document is classified and pending", { docs: [doc("foreign", T0, { agentIdentity: "foreign" })], expected: [1, 1, 1] }],
  ["new own document is classified but not pending", { docs: [doc("own", T0)], expected: [1, 1, 0] }],
  ["unknown recent document without map is rejected", { docs: [doc("unknown", T0)], map: null, error: /1 document\(s\).*have no classification/ }],
  ["known foreign document works without map", { docs: [doc("known", T0)], known: [["known", "other"]], map: null, expected: [1, 0, 1] }],
  ["empty listing has zero counters", { docs: [], map: null, expected: [0, 0, 0] }],
  ["mixed listing counts only recent foreign documents as pending", { docs: [doc("old", BEFORE), doc("known", T0), doc("new-own", AFTER), doc("new-foreign", AFTER, { agentIdentity: "foreign" })], known: [["old", "other"], ["known", "other"]], expected: [3, 2, 2] }],
];

for (const [name, input] of cases) test(name, () => exercise(input));
