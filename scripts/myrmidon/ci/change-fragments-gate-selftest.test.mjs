import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

// CHANGE-FRAGMENTS: self-test of the PR gate. In a pull_request run of the
// checks job the event payload is on disk ($GITHUB_EVENT_PATH) and the
// repository is checked out with full history (fetch-depth: 0), so the gate
// can run here without any workflow change: the "Script tests" step already
// executes every *.test.mjs under scripts/myrmidon/.
//
// Deliberately a *test* and not a separate workflow step: the session token
// cannot push workflow edits (no `workflow` scope), and the checks job runs
// on every tier, PRs included. Outside a pull_request (push to main, local
// runs) this test is a no-op — the release cut lands through main, and
// re-judging merged history would block every push.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, "change-fragments-gate.mjs");
const COLLECTOR = path.join(HERE, "..", "release", "collect-fragments.mjs");
const ROOT = path.resolve(HERE, "../../..");

const eventPath = process.env.GITHUB_EVENT_PATH;
const isPullRequest =
  process.env.GITHUB_EVENT_NAME === "pull_request" &&
  eventPath &&
  fs.existsSync(eventPath);

it("PR gate: shared registry documents are not edited by hand in this PR", (t) => {
  if (!isPullRequest) {
    t.skip("not a pull_request run — the gate judges PRs only");
    return;
  }
  const res = spawnSync("node", [GATE, "--root", ROOT, "--event-file", eventPath], {
    encoding: "utf8",
  });
  assert.equal(
    res.status,
    0,
    `change-fragments gate failed:\n${res.stdout}\n${res.stderr}`,
  );
});

// Keep the gate itself honest: a broken gate must fail loudly here too, so
// the suite above can never silently pass on a usage error.
it("the gate exits 2 on a bogus event file path", () => {
  const missing = path.join(os.tmpdir(), "change-fragments-no-such-event.json");
  const res = spawnSync("node", [GATE, "--root", ROOT, "--event-file", missing], {
    encoding: "utf8",
  });
  assert.equal(res.status, 2);
});

// A fragment that the release collector cannot fold (a settings or
// divergence section named by a heading the target document does not have)
// must not reach main — it silently breaks every later release cut. The
// dry-run of the real collector over the checked-out tree catches exactly
// that: it parses and folds every fragment in docs/myrmidon/changes/ against
// the shared documents, writes nothing, and exits non-zero on the first
// broken fragment. Runs on PRs (the PR's own fragment is judged together with
// the pending ones) and on pushes to main (a broken fragment already in main
// turns the push red). A release-cut PR has deleted the fragments by then, so
// the dry-run is green.
it("collect-fragments --dry-run folds every pending fragment", () => {
  const res = spawnSync(
    "node",
    [COLLECTOR, "--version", "0.0.0", "--root", ROOT, "--dry-run"],
    { encoding: "utf8" },
  );
  assert.equal(
    res.status,
    0,
    `collect-fragments --dry-run failed:\n${res.stdout}\n${res.stderr}`,
  );
});
