import assert from "node:assert/strict";
import { it } from "node:test";
import { main, scanText } from "./scan-text.mjs";

const warning = "::warning title=internal addresses::MYRMIDON_FORBIDDEN_PATTERNS is not set; forbidden-pattern check skipped";
const removal = "Remove the secret or internal address from the text. Public repository rules: docs/myrmidon/CONVENTIONS.md, section 9.";
const address = [10, 23, 45, 67].join(".");
const host = ["internal", "fixture", "example"].join("-");
const otherHost = ["another", "fixture", "example"].join("-");

it("isolates consecutive stdin scans, errors and environment patterns", async (t) => {
  let reads = 0;
  const envA = {};
  const envB = { MYRMIDON_FORBIDDEN_PATTERNS: `# fixture\n${host}` };
  const envC = { MYRMIDON_FORBIDDEN_PATTERNS: otherHost };
  const cases = [
    { name: "initial clean", text: "ordinary prose", env: envA, expected: [0, [["log", warning], ["log", "Scanned 1 line(s): 0 finding(s)."]]] },
    { name: "private address", text: `first\n${address}`, env: envA, expected: [1, [["log", warning], ["log", "Scanned 2 line(s): 1 finding(s)."], ["log", "::error line=2::private address in 10/8"], ["error", removal]]] },
    { name: "read error", error: true, env: envA, expected: [2, [["error", "Cannot read stdin: EAGAIN"]]] },
    { name: "clean after error and finding", text: "ordinary prose", env: envA, expected: [0, [["log", warning], ["log", "Scanned 1 line(s): 0 finding(s)."]]] },
    { name: "configured forbidden pattern", text: `first\n${host}`, env: envB, expected: [1, [["log", "Scanned 2 line(s): 1 finding(s)."], ["log", "::error line=2::forbidden pattern #2"], ["error", removal]]] },
    { name: "different environment does not inherit pattern", text: host, env: envC, expected: [0, [["log", "Scanned 1 line(s): 0 finding(s)."]]] },
    { name: "different environment matches its own pattern", text: otherHost, env: envC, expected: [1, [["log", "Scanned 1 line(s): 1 finding(s)."], ["log", "::error line=1::forbidden pattern #1"], ["error", removal]]] },
    { name: "unset environment does not inherit patterns", text: otherHost, env: envA, expected: [0, [["log", warning], ["log", "Scanned 1 line(s): 0 finding(s)."]]] },
    { name: "invalid argv does not read", argv: ["--nope"], env: envA, expected: [2, [["error", "Unknown argument: --nope"]]], noRead: true },
    { name: "missing file argument does not read", argv: ["--file"], env: envA, expected: [2, [["error", "--file requires a path"]]], noRead: true },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const beforeEnv = { ...scenario.env };
      const beforeReads = reads;
      const output = [];
      const log = { log: (message) => output.push(["log", message]), error: (message) => output.push(["error", message]) };
      const readStdin = () => {
        reads += 1;
        if (scenario.error) throw Object.assign(new Error("temporary failure"), { code: "EAGAIN" });
        return scenario.text;
      };
      const code = main(scenario.argv ?? [], scenario.env, log, readStdin);
      assert.deepEqual([code, output], scenario.expected);
      assert.deepEqual(reads - beforeReads, scenario.noRead ? 0 : 1);
      assert.deepEqual(scenario.env, beforeEnv);
    });
  }
});

it("finding payload contains rule and line only, not the matched value", () => {
  const value = ["synthetic", "value"].join("-");
  const input = `${["pass", "word"].join("")}=${value}`;
  assert.deepEqual(scanText(`clean\n${input}`), [{ line: 2, rule: "secret-like assignment" }]);
  assert.deepEqual(scanText("ordinary prose"), []);
});
