import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSkillSizes } from "../check-skill-size.mjs";

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
