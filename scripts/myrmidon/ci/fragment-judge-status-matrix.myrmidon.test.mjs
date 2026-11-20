import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judge } from "./change-fragments-gate.mjs";

const registries = [
  "docs/myrmidon/CHANGELOG.md",
  "docs/myrmidon/CHANGELOG.ru.md",
  "docs/myrmidon/DIVERGENCE.md",
  "docs/myrmidon/SETTINGS.md",
  "docs/myrmidon/SETTINGS.ru.md",
];

function frozenChanges(changes) {
  return Object.freeze(changes.map((change) => Object.freeze(change)));
}

describe("judge registry status matrix", () => {
  for (const file of registries) {
    for (const status of ["A", "M", "D", "R100", "C100"]) {
      for (const releaseCut of [false, true]) {
        it(`${file} ${status} with release cut ${releaseCut}`, () => {
          const registry = { status, file };
          const fragment = { status: "D", file: "docs/myrmidon/changes/entry.md" };
          const changes = frozenChanges(releaseCut ? [registry, fragment] : [registry]);
          const violates = !releaseCut || status === "A";
          assert.deepEqual(judge(changes), {
            ok: !violates,
            violations: violates ? [registry] : [],
            deletedFragments: releaseCut ? [fragment] : [],
            releaseCut,
          });
          assert.deepEqual(changes, releaseCut ? [registry, fragment] : [registry]);
        });
      }
    }
  }

  for (const fragment of [
    { status: "D", file: "docs/myrmidon/changes-other/entry.md" },
    { status: "D", file: "docs/myrmidon/changes" },
    { status: "D", file: "other/docs/myrmidon/changes/entry.md" },
    { status: "M", file: "docs/myrmidon/changes/entry.md" },
    { status: "A", file: "docs/myrmidon/changes/entry.md" },
  ]) {
    it(`${fragment.status} ${fragment.file} does not exempt registry changes`, () => {
      const registry = { status: "M", file: registries[0] };
      const changes = frozenChanges([fragment, registry]);
      assert.deepEqual(judge(changes), {
        ok: false, violations: [registry], deletedFragments: [], releaseCut: false,
      });
      assert.deepEqual(changes, [fragment, registry]);
    });
  }

  it("preserves input order in both result lists without mutating frozen changes", () => {
    const firstViolation = { status: "A", file: registries[4] };
    const firstDeletion = { status: "D", file: "docs/myrmidon/changes/z.md" };
    const secondViolation = { status: "A", file: registries[0] };
    const secondDeletion = { status: "D", file: "docs/myrmidon/changes/a.md" };
    const allowed = { status: "M", file: registries[2] };
    const changes = frozenChanges([firstViolation, firstDeletion, allowed, secondDeletion, secondViolation]);
    assert.deepEqual(judge(changes), {
      ok: false,
      violations: [firstViolation, secondViolation],
      deletedFragments: [firstDeletion, secondDeletion],
      releaseCut: true,
    });
    assert.deepEqual(changes, [firstViolation, firstDeletion, allowed, secondDeletion, secondViolation]);
  });
});
