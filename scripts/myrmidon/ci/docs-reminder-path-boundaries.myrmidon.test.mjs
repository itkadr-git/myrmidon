import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commentBody, judge } from "./docs-reminder.mjs";

const triggers = [
  "server/schema.ts",
  "server/src/routes/user-schemas.ts",
  "server/a/b/schema-extra.ts",
  "server/src/myrmidon/schema.json",
  "packages/paperclip-runner/generated/capability/nested/item.json",
  ".agents/schemas/item.json",
];
const nonTriggers = [
  "server/schema.json",
  "server/schema-dir/item.ts",
  "server-other/schema.ts",
  "packages/paperclip-runner/generated/capability-other/item.json",
  ".agents/schemas-other/item.json",
  "server/src/myrmidon/schema-dir/item.json",
];
const docsCases = [
  ["docs/myrmidon/changes/change.md", true],
  ["skills/myrmidon/references/api.md", true],
  ["docs/myrmidon/changes-other/change.md", false],
  ["skills/myrmidon/references-other/api.md", false],
];

describe("docs reminder path boundaries", () => {
  for (const trigger of triggers) {
    it(`classifies and suppresses ${trigger} only for exact docs directories`, () => {
      assert.deepEqual(judge([trigger]), {
        triggerFiles: [trigger], docsFiles: [], remind: true,
      });
      for (const [doc, suppresses] of docsCases) {
        const input = Object.freeze([doc, trigger]);
        assert.deepEqual(judge(input), {
          triggerFiles: [trigger],
          docsFiles: suppresses ? [doc] : [],
          remind: !suppresses,
        }, `${trigger} with ${doc}`);
        assert.deepEqual(input, [doc, trigger]);
      }
    });
  }

  for (const path of nonTriggers) {
    it(`does not trigger on ${path}`, () => {
      assert.deepEqual(judge([path]), { triggerFiles: [], docsFiles: [], remind: false });
    });
  }

  it("preserves input and the order of both filtered lists", () => {
    const input = Object.freeze([
      nonTriggers[0], triggers[2], docsCases[1][0], triggers[0],
      docsCases[0][0], triggers[4], nonTriggers[1],
    ]);
    const original = [...input];
    assert.deepEqual(judge(input), {
      triggerFiles: [triggers[2], triggers[0], triggers[4]],
      docsFiles: [docsCases[1][0], docsCases[0][0]],
      remind: false,
    });
    assert.deepEqual(input, original);
  });
});

describe("docs reminder comment boundary", () => {
  for (const count of [0, 1, 10, 11]) {
    it(`lists the first ${Math.min(count, 10)} of ${count} paths with the exact remainder`, () => {
      const files = Object.freeze(Array.from({ length: count }, (_, i) => `server/schema-${i}.ts`));
      const body = commentBody({ triggerFiles: files });
      const bullets = body.split("\n").filter((line) => line.startsWith("- "));
      const expected = files.slice(0, 10).map((file) => `- \`${file}\``);
      if (count === 11) expected.push("- …and 1 more");
      assert.deepEqual(bullets, expected);
      assert.deepEqual(files, Array.from({ length: count }, (_, i) => `server/schema-${i}.ts`));
    });
  }
});
