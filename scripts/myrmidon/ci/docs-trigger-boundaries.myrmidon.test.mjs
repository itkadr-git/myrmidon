import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judge } from "./docs-reminder.mjs";

describe("docs reminder trigger boundaries", () => {
  const cases = [
    {
      name: "generated capability directory and its neighbor",
      files: ["packages/paperclip-runner/generated/capability/a.json", "packages/paperclip-runner/generated/capability-other/a.json"],
      verdict: { triggerFiles: ["packages/paperclip-runner/generated/capability/a.json"], docsFiles: [], remind: true },
    },
    {
      name: "agent schema directory and its neighbor",
      files: [".agents/schemas/a.json", ".agents/schemas-old/a.json"],
      verdict: { triggerFiles: [".agents/schemas/a.json"], docsFiles: [], remind: true },
    },
    {
      name: "server TypeScript schema basename, directory, extension, and client boundaries",
      files: ["server/a-schema.ts", "server/schema/a.ts", "server/a-schema.tsx", "client/a-schema.ts"],
      verdict: { triggerFiles: ["server/a-schema.ts"], docsFiles: [], remind: true },
    },
    {
      name: "Myrmidon schema JSON and other server JSON",
      files: ["server/src/myrmidon/a-schema.json", "server/src/other/a-schema.json"],
      verdict: { triggerFiles: ["server/src/myrmidon/a-schema.json"], docsFiles: [], remind: true },
    },
    {
      name: "negative controls alone do not remind",
      files: ["packages/paperclip-runner/generated/capability-other/a.json", ".agents/schemas-old/a.json", "server/schema/a.ts", "server/a-schema.tsx", "client/a-schema.ts", "server/src/other/a-schema.json"],
      verdict: { triggerFiles: [], docsFiles: [], remind: false },
    },
    {
      name: "change fragment suppresses reminder",
      files: ["server/a-schema.ts", "docs/myrmidon/changes/a.md"],
      verdict: { triggerFiles: ["server/a-schema.ts"], docsFiles: ["docs/myrmidon/changes/a.md"], remind: false },
    },
    {
      name: "skill reference suppresses reminder",
      files: ["server/a-schema.ts", "skills/myrmidon/references/a.md"],
      verdict: { triggerFiles: ["server/a-schema.ts"], docsFiles: ["skills/myrmidon/references/a.md"], remind: false },
    },
    {
      name: "both docs prefixes suppress reminder",
      files: ["server/a-schema.ts", "docs/myrmidon/changes/a.md", "skills/myrmidon/references/a.md"],
      verdict: { triggerFiles: ["server/a-schema.ts"], docsFiles: ["docs/myrmidon/changes/a.md", "skills/myrmidon/references/a.md"], remind: false },
    },
    {
      name: "neighboring docs directories do not suppress reminder",
      files: ["server/a-schema.ts", "docs/myrmidon/changes-old/a.md", "skills/myrmidon/references-old/a.md"],
      verdict: { triggerFiles: ["server/a-schema.ts"], docsFiles: [], remind: true },
    },
  ];

  for (const { name, files, verdict } of cases) {
    it(name, () => assert.deepStrictEqual(judge(files), verdict));
  }

  it("preserves input, order, and duplicates across mixed files", () => {
    const files = [
      "skills/myrmidon/references/b.md", "server/a-schema.ts", "ui/a.ts",
      "docs/myrmidon/changes/a.md", ".agents/schemas/a.json", "server/a-schema.ts",
      "skills/myrmidon/references/b.md", "docs/myrmidon/changes-old/a.md",
      "docs/myrmidon/changes/a.md",
    ];
    const before = [...files];
    assert.deepStrictEqual(judge(files), {
      triggerFiles: ["server/a-schema.ts", ".agents/schemas/a.json", "server/a-schema.ts"],
      docsFiles: ["skills/myrmidon/references/b.md", "docs/myrmidon/changes/a.md", "skills/myrmidon/references/b.md", "docs/myrmidon/changes/a.md"],
      remind: false,
    });
    assert.deepStrictEqual(files, before);
  });

  it("does not retain state between a reminder, empty input, and a later call", () => {
    assert.deepStrictEqual(judge(["server/a-schema.ts"]), {
      triggerFiles: ["server/a-schema.ts"], docsFiles: [], remind: true,
    });
    assert.deepStrictEqual(judge([]), { triggerFiles: [], docsFiles: [], remind: false });
    assert.deepStrictEqual(judge(["docs/myrmidon/changes/a.md"]), {
      triggerFiles: [], docsFiles: ["docs/myrmidon/changes/a.md"], remind: false,
    });
  });
});
