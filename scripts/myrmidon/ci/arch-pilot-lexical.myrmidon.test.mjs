import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { checkNoPilot } from "./arch-invariants-gate.mjs";

const server = "server/src/myrmidon/swarm-claim";
const shared = "packages/shared/src/myrmidon-swarm-claim.ts";
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(process.env.HOME, "cache/scratch");

function withFiles(files, verify) {
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "arch-pilot-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(root, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    verify(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const suffix = ': "pilot" in code is forbidden in swarm modules (INV-12)';

describe("INV-12 lexical boundaries", () => {
  for (const file of [`${server}/nested/settings.ts`, `${server}/nested/view.tsx`, shared]) {
    for (const [token, forbidden] of [
      ["pilot", true], ["PILOT", true], ["pilotEnabled", true],
      ["pilotPercent", true], ["pilot_enabled", true], ["pilot_percent", true],
      ["autopilot", false], ["piloting", false], ["pilotValue", false],
      ["prepilot", false], ["pilot_enabled_extra", false],
      // Field-name alternatives also match when embedded at the end of an identifier.
      ["autopilotEnabled", true],
    ]) {
      it(`${file}: ${token}`, () => {
        withFiles({ [file]: `export const ${token} = true;\n` }, (root) => {
          assert.deepEqual(checkNoPilot(root), forbidden ? [`${file}:1${suffix}`] : []);
        });
      });
    }
  }

  it("preserves line numbers across blank lines and comments, including code after block close", () => {
    const file = `${server}/nested/lines.ts`;
    withFiles({ [file]: [
      "// pilot",
      "",
      "/* pilot",
      "pilotEnabled",
      "*/ const pilot = true; // pilotPercent",
      "const safe = true; /* pilot */",
      "const pilot_percent = 10;",
      "",
    ].join("\n") }, (root) => {
      assert.deepEqual(checkNoPilot(root), [`${file}:5${suffix}`, `${file}:7${suffix}`]);
    });
  });

  it("excludes designated directories and myrmidon test files but scans ordinary test files", () => {
    const files = {
      [`${server}/nested/production.ts`]: "const pilot = true;\n",
      [`${server}/nested/production.tsx`]: "const pilot = true;\n",
      [`${server}/nested/ordinary.test.ts`]: "const pilot = true;\n",
      [`${server}/nested/ordinary.test.tsx`]: "const pilot = true;\n",
      [`${server}/node_modules/nested/hidden.ts`]: "const pilot = true;\n",
      [`${server}/dist/nested/hidden.tsx`]: "const pilot = true;\n",
      [`${server}/tests/nested/hidden.ts`]: "const pilot = true;\n",
      [`${server}/__tests__/nested/hidden.tsx`]: "const pilot = true;\n",
      [`${server}/nested/hidden.myrmidon.test.ts`]: "const pilot = true;\n",
      [`${server}/nested/hidden.myrmidon.test.tsx`]: "const pilot = true;\n",
      [shared]: "// pilot\nconst pilotEnabled = true;\n",
    };
    withFiles(files, (root) => {
      assert.deepEqual(checkNoPilot(root).sort(), [
        `${server}/nested/ordinary.test.ts:1${suffix}`,
        `${server}/nested/ordinary.test.tsx:1${suffix}`,
        `${server}/nested/production.ts:1${suffix}`,
        `${server}/nested/production.tsx:1${suffix}`,
        `${shared}:2${suffix}`,
      ].sort());
    });
  });
});
