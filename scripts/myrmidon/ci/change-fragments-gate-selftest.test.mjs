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
