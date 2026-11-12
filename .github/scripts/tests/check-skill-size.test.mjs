import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSkillSizes, shouldCheckSkills, SKILL_PATH_PREFIXES } from "../check-skill-size.mjs";

test("checkSkillSizes passes when all skills are under limit or correctly allowlisted", () => {
  const tmp = mkdtempSync(join(tmpdir(), "skill-size-"));
  const allowlist = new Map([
    ["over-allowed/SKILL.md", "Allowed oversized skill"],
  ]);

  // Under limit, not in allowlist -> OK
  mkdirSync(join(tmp, "ok-skill"), { recursive: true });
  writeFileSync(join(tmp, "ok-skill", "SKILL.md"), "A".repeat(100));

  // Over limit, in allowlist -> OK
  mkdirSync(join(tmp, "over-allowed"), { recursive: true });
  writeFileSync(join(tmp, "over-allowed", "SKILL.md"), "A".repeat(20000));

  const result = checkSkillSizes({ root: tmp, limit: 1000, allowlist });
  assert.equal(result.passed, true);
  assert.equal(result.violations.length, 0);
});

test("checkSkillSizes fails when a skill exceeds limit and is not allowlisted", () => {
  const tmp = mkdtempSync(join(tmpdir(), "skill-size-"));
  const allowlist = new Map();

  mkdirSync(join(tmp, "over-unallowed"), { recursive: true });
  writeFileSync(join(tmp, "over-unallowed", "SKILL.md"), "A".repeat(20000));

  const result = checkSkillSizes({ root: tmp, limit: 1000, allowlist });
  assert.equal(result.passed, false);
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].reason, /exceeds the 1000 bytes limit/);
});

test("checkSkillSizes fails when an allowlisted skill has shrunk below limit", () => {
  const tmp = mkdtempSync(join(tmpdir(), "skill-size-"));
  const allowlist = new Map([
    ["shrunk-skill/SKILL.md", "Was large, now small"],
  ]);

  mkdirSync(join(tmp, "shrunk-skill"), { recursive: true });
  writeFileSync(join(tmp, "shrunk-skill", "SKILL.md"), "A".repeat(100));

  const result = checkSkillSizes({ root: tmp, limit: 1000, allowlist });
  assert.equal(result.passed, false);
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].reason, /within the 1000 bytes limit/);
});

test("shouldCheckSkills filters PR diff by skill path prefixes", () => {
  // When no gitExec provided or SHAs empty, defaults to true
  assert.equal(shouldCheckSkills(null, null), true);
  assert.equal(shouldCheckSkills("base", null), true);
  assert.equal(shouldCheckSkills(null, "head"), true);

  const mockGit = (files) => () => files.join("\0");

  // PR touching unrelated files -> false
  assert.equal(
    shouldCheckSkills("base", "head", {
      gitExec: mockGit(["server/src/index.ts", "docs/README.md"]),
    }),
    false,
  );

  // PR touching skill paths -> true for each prefix
  for (const prefix of SKILL_PATH_PREFIXES) {
    assert.equal(
      shouldCheckSkills("base", "head", {
        gitExec: mockGit(["server/src/index.ts", `${prefix}some-skill/SKILL.md`]),
      }),
      true,
      `expected match for prefix: ${prefix}`,
    );
  }

  // Fails open if gitExec throws
  assert.equal(
    shouldCheckSkills("base", "head", {
      gitExec: () => {
        throw new Error("git failure");
      },
    }),
    true,
  );
});

