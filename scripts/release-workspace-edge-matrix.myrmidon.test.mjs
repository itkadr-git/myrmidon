import assert from "node:assert/strict";
import test from "node:test";

import { findUnpublishableWorkspaceEdges } from "./release-package-map.mjs";

function record(name, publishFromCi, pkg = {}) {
  return { name, dir: `packages/${name.split("/").at(-1)}`, publishFromCi, pkg };
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  for (const spec of ["workspace:*", "workspace:^", "workspace:~"]) {
    for (const targetState of ["missing", "off-train", "published"]) {
      test(`${section} ${spec} to ${targetState} target`, () => {
        const consumer = record("@myrmidon/consumer", true, {
          [section]: { "@myrmidon/target": spec },
        });
        const records = [consumer];
        if (targetState !== "missing") {
          records.push(record("@myrmidon/target", targetState === "published"));
        }
        const problems = findUnpublishableWorkspaceEdges(deepFreeze(records));
        if (targetState === "published") {
          assert.deepEqual(problems, []);
        } else {
          assert.equal(problems.length, 1);
          assert.ok(problems[0].includes("@myrmidon/consumer"));
          assert.ok(problems[0].includes("@myrmidon/target"));
          assert.ok(problems[0].includes(section));
        }
      });
    }
  }
}

test("ignores external workspace specs, ordinary semver, and off-train consumers", () => {
  const records = deepFreeze([
    record("@myrmidon/consumer", true, {
      dependencies: { "outside-package": "workspace:*", "@myrmidon/semver": "^1.2.3" },
      optionalDependencies: { "@outside/package": "workspace:^", "@myrmidon/semver": "~1.2.3" },
      peerDependencies: { "outside-package": "workspace:~", "@myrmidon/semver": "1.2.3" },
    }),
    record("@myrmidon/semver", false),
    record("@myrmidon/off-train", false, {
      dependencies: { "@myrmidon/missing": "workspace:*" },
      optionalDependencies: { "@myrmidon/missing": "workspace:^" },
      peerDependencies: { "@myrmidon/missing": "workspace:~" },
    }),
  ]);
  assert.deepEqual(findUnpublishableWorkspaceEdges(records), []);
});

test("reports every forbidden edge exactly once and is deterministic on frozen input", () => {
  const records = deepFreeze([
    record("@myrmidon/consumer", true, {
      dependencies: { "@myrmidon/off": "workspace:*", "@myrmidon/missing": "workspace:^" },
      optionalDependencies: { "@myrmidon/off": "workspace:~" },
      peerDependencies: { "@myrmidon/missing": "workspace:*" },
    }),
    record("@myrmidon/off", false),
  ]);
  const first = findUnpublishableWorkspaceEdges(records);
  assert.equal(first.length, 4);
  for (const [section, target] of [
    ["dependencies", "@myrmidon/off"],
    ["dependencies", "@myrmidon/missing"],
    ["optionalDependencies", "@myrmidon/off"],
    ["peerDependencies", "@myrmidon/missing"],
  ]) {
    assert.equal(first.filter((message) => message.includes("@myrmidon/consumer") &&
      message.includes(target) && message.includes(`\"${section}\"`)).length, 1);
  }
  assert.deepEqual(findUnpublishableWorkspaceEdges(records), first);
});
