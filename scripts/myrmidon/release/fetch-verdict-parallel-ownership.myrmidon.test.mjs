import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { run } from "./fetch-release-verdict.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

for (const bVerdict of ["confirmed", "failed"]) {
  test(`parallel runs isolate confirmed A and ${bVerdict} B`, async () => {
    const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || os.homedir();
    assert.ok(scratch && path.isAbsolute(scratch), "an absolute run scratch directory is required");
    const dir = fs.mkdtempSync(path.join(scratch, "parallel-verdict-"));
    try {
      const inputs = ["a", "b"].map((name) => ({
        args: { version: "1.7.0", issue: `issue-${name}`, out: path.join(dir, `${name}.json`) },
        env: { PAPERCLIP_API_URL: `https://${name}.example.invalid/`, PAPERCLIP_API_KEY: `fixture-key-${name}`, PAPERCLIP_COMPANY_ID: `company-${name}` },
      }));
      const original = structuredClone(inputs);
      const verdicts = inputs.map(({ args }, index) => ({
        issueId: args.issue,
        releaseLabel: "1.7",
        candidateIssueIds: [`candidate-${index}`],
        deployedVersion: index === 1 && bVerdict === "failed" ? null : `build-${index}`,
        verdict: index === 1 ? bVerdict : "confirmed",
        failureReason: index === 1 && bVerdict === "failed" ? "not_deployed" : null,
        reason: index === 1 && bVerdict === "failed" ? "candidate not deployed" : "all members present",
        checkedAt: "2026-11-17T00:00:00.000Z",
        members: [{ issueId: `candidate-${index}`, status: index === 1 && bVerdict === "failed" ? "missing" : "verified" }],
        signature: (index === 0 ? "a" : "b").repeat(64),
      }));
      const gates = [deferred(), deferred()];
      const calls = [];
      const logs = [[], []];
      const fetchBoard = (api, pathname, init) => {
        calls.push({ api: structuredClone(api), pathname, init: structuredClone(init) });
        return gates[calls.length - 1].promise;
      };
      const pending = inputs.map(({ args, env }, index) => run(args, { env, log: (message) => logs[index].push(message) }, fetchBoard));
      const both = Promise.all(pending);
      assert.deepEqual(calls, inputs.map(({ args, env }) => ({
        api: { apiUrl: env.PAPERCLIP_API_URL.slice(0, -1), apiKey: env.PAPERCLIP_API_KEY, companyId: env.PAPERCLIP_COMPANY_ID },
        pathname: `/api/issues/${args.issue}/release-verify`,
        init: { method: "POST", body: "{}" },
      })));
      gates[1].resolve(verdicts[1]);
      assert.equal(await pending[1], 0);
      assert.equal(fs.existsSync(inputs[0].args.out), false);
      gates[0].resolve(verdicts[0]);
      assert.deepEqual(await both, [0, 0]);
      for (let index = 0; index < inputs.length; index += 1) {
        assert.equal(fs.readFileSync(inputs[index].args.out, "utf8"), `${JSON.stringify(verdicts[index], null, 2)}\n`);
        assert.ok(logs[index].every((message) => !message.includes("REFUSED")));
      }
      assert.deepEqual(inputs, original);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
