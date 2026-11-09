import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  ALLOWLIST,
  checkSkillsDrift,
  findSkillFiles,
  isAllowlisted,
  shouldCheckSkills,
  SKILL_PATH_PREFIXES,
  SKILL_ROOTS,
} from '../check-skills-drift.mjs';

describe('check-skills-drift', () => {
  let tempBase;

  beforeEach(() => {
    const scratchDir = process.env.TMPDIR || process.env.PAPERCLIP_SCRATCH_DIR || os.tmpdir();
    tempBase = fs.mkdtempSync(path.join(scratchDir, 'test-skills-drift-'));
  });

  afterEach(() => {
    if (tempBase && fs.existsSync(tempBase)) {
      fs.rmSync(tempBase, { recursive: true, force: true });
    }
  });

  it('passes when duplicate skills have identical SKILL.md contents (same fixture)', () => {
    const root1 = path.join(tempBase, 'root1');
    const root2 = path.join(tempBase, 'root2');

    const skill1Dir = path.join(root1, 'common-skill');
    const skill2Dir = path.join(root2, 'nested', 'common-skill');

    fs.mkdirSync(skill1Dir, { recursive: true });
    fs.mkdirSync(skill2Dir, { recursive: true });

    const sharedContent = '---\nname: common-skill\ndescription: Test skill\n---\n# Shared Content\n';
    fs.writeFileSync(path.join(skill1Dir, 'SKILL.md'), sharedContent, 'utf8');
    fs.writeFileSync(path.join(skill2Dir, 'SKILL.md'), sharedContent, 'utf8');

    const result = checkSkillsDrift({
      rootDir: tempBase,
      roots: ['root1', 'root2'],
      allowlist: new Set(),
    });

    assert.equal(result.passed, true);
    assert.equal(result.duplicates.length, 1);
    assert.equal(result.duplicates[0].slug, 'common-skill');
    assert.equal(result.duplicates[0].copies.length, 2);
    assert.equal(result.drifts.length, 0);
    assert.match(result.message, /All duplicate skills are identical/);
  });

  it('fails when duplicate skills have different SKILL.md contents (diff fixture)', () => {
    const root1 = path.join(tempBase, 'root1');
    const root2 = path.join(tempBase, 'root2');

    const skill1Dir = path.join(root1, 'drifting-skill');
    const skill2Dir = path.join(root2, 'catalog', 'drifting-skill');

    fs.mkdirSync(skill1Dir, { recursive: true });
    fs.mkdirSync(skill2Dir, { recursive: true });

    fs.writeFileSync(path.join(skill1Dir, 'SKILL.md'), '# Original Version\nLength is 20 bytes.\n', 'utf8');
    fs.writeFileSync(path.join(skill2Dir, 'SKILL.md'), '# Altered Version with more details\nLength is longer.\n', 'utf8');

    const result = checkSkillsDrift({
      rootDir: tempBase,
      roots: ['root1', 'root2'],
      allowlist: new Set(),
    });

    assert.equal(result.passed, false);
    assert.equal(result.duplicates.length, 1);
    assert.equal(result.drifts.length, 1);
    assert.equal(result.drifts[0].slug, 'drifting-skill');
    assert.equal(result.drifts[0].copies.length, 2);
    assert.match(result.message, /Skills drift detected: found 1 duplicate skill/);
    assert.match(result.message, /drifting-skill/);
    assert.match(result.message, /root1\/drifting-skill\/SKILL\.md/);
    assert.match(result.message, /root2\/catalog\/drifting-skill\/SKILL\.md/);
  });

  it('passes when duplicate skills diverge but slug is in allowlist (allowlist fixture)', () => {
    const root1 = path.join(tempBase, 'root1');
    const root2 = path.join(tempBase, 'root2');

    const skill1Dir = path.join(root1, 'exempt-skill');
    const skill2Dir = path.join(root2, 'catalog', 'exempt-skill');

    fs.mkdirSync(skill1Dir, { recursive: true });
    fs.mkdirSync(skill2Dir, { recursive: true });

    fs.writeFileSync(path.join(skill1Dir, 'SKILL.md'), '# Root 1 version', 'utf8');
    fs.writeFileSync(path.join(skill2Dir, 'SKILL.md'), '# Root 2 catalog-local version', 'utf8');

    const customAllowlist = new Set(['exempt-skill']);

    const result = checkSkillsDrift({
      rootDir: tempBase,
      roots: ['root1', 'root2'],
      allowlist: customAllowlist,
    });

    assert.equal(result.passed, true);
    assert.equal(result.duplicates.length, 1);
    assert.equal(result.drifts.length, 0);
    assert.equal(result.allowedDrifts.length, 1);
    assert.equal(result.allowedDrifts[0].slug, 'exempt-skill');
    assert.match(result.message, /1 allowed drifts/);
  });

  it('handles unique skills without flagging duplicates', () => {
    const root1 = path.join(tempBase, 'root1');
    const root2 = path.join(tempBase, 'root2');

    const skill1Dir = path.join(root1, 'unique-a');
    const skill2Dir = path.join(root2, 'unique-b');

    fs.mkdirSync(skill1Dir, { recursive: true });
    fs.mkdirSync(skill2Dir, { recursive: true });

    fs.writeFileSync(path.join(skill1Dir, 'SKILL.md'), '# Unique A', 'utf8');
    fs.writeFileSync(path.join(skill2Dir, 'SKILL.md'), '# Unique B', 'utf8');

    const result = checkSkillsDrift({
      rootDir: tempBase,
      roots: ['root1', 'root2'],
    });

    assert.equal(result.passed, true);
    assert.equal(result.duplicates.length, 0);
    assert.equal(result.drifts.length, 0);
  });

  it('isAllowlisted matches Set, Array, and pair object forms', () => {
    assert.equal(isAllowlisted('my-skill', 'a', 'b', new Set(['my-skill'])), true);
    assert.equal(isAllowlisted('my-skill', 'a', 'b', ['my-skill']), true);
    assert.equal(isAllowlisted('other', 'a', 'b', new Set(['my-skill'])), false);

    const pairAllowlist = [{ pair: ['root1/skill', 'root2/skill'] }];
    assert.equal(isAllowlisted('any', 'path/root1/skill', 'path/root2/skill', pairAllowlist), true);
    assert.equal(isAllowlisted('any', 'path/root2/skill', 'path/root1/skill', pairAllowlist), true);
    assert.equal(isAllowlisted('any', 'path/root1/skill', 'path/other/skill', pairAllowlist), false);
  });

  it('findSkillFiles handles symlinks and ignores node_modules and .git', () => {
    const root = path.join(tempBase, 'repo');
    const realSkill = path.join(root, 'skills', 'alpha');
    const nodeModulesSkill = path.join(root, 'node_modules', 'ignored');
    const symlinkedSkill = path.join(root, 'mirrored', 'alpha');

    fs.mkdirSync(realSkill, { recursive: true });
    fs.mkdirSync(nodeModulesSkill, { recursive: true });
    fs.mkdirSync(path.join(root, 'mirrored'), { recursive: true });

    fs.writeFileSync(path.join(realSkill, 'SKILL.md'), '# Alpha', 'utf8');
    fs.writeFileSync(path.join(nodeModulesSkill, 'SKILL.md'), '# Ignored', 'utf8');

    fs.symlinkSync(realSkill, symlinkedSkill, 'dir');

    const found = findSkillFiles(root).map((f) => path.relative(root, f).replace(/\\/g, '/'));
    assert.ok(found.includes('skills/alpha/SKILL.md'));
    assert.ok(found.includes('mirrored/alpha/SKILL.md'));
    assert.ok(!found.some((f) => f.includes('node_modules')));
  });

  it('shouldCheckSkills filters PR diff by skill path prefixes', () => {
    // When no gitExec provided or SHAs empty, defaults to true
    assert.equal(shouldCheckSkills(null, null), true);

    const mockGit = (files) => () => files.join('\0');

    // PR touching unrelated files -> false
    assert.equal(
      shouldCheckSkills('base', 'head', {
        gitExec: mockGit(['server/src/index.ts', 'docs/README.md']),
      }),
      false,
    );

    // PR touching skill paths -> true
    for (const prefix of SKILL_PATH_PREFIXES) {
      assert.equal(
        shouldCheckSkills('base', 'head', {
          gitExec: mockGit(['server/src/index.ts', `${prefix}some-skill/SKILL.md`]),
        }),
        true,
        `expected match for prefix: ${prefix}`,
      );
    }
  });

  it('verifies repo state: doc-maintenance currently diverges while company-creator and paperclip are in sync', () => {
    const REPO_ROOT = path.resolve(path.join(import.meta.dirname, '../../..'));
    const result = checkSkillsDrift({
      rootDir: REPO_ROOT,
      roots: SKILL_ROOTS,
      allowlist: ALLOWLIST,
    });

    // doc-maintenance diverges, so checkSkillsDrift() fails on current repo
    assert.equal(result.passed, false);
    const docDrift = result.drifts.find((d) => d.slug === 'doc-maintenance');
    assert.ok(docDrift, 'expected doc-maintenance to be detected as drifting');
    assert.equal(docDrift.copies.length, 2);

    // company-creator and paperclip are duplicate slugs but identical
    const companyCreator = result.duplicates.find((d) => d.slug === 'company-creator');
    assert.ok(companyCreator, 'expected company-creator duplicate to be tracked');
    assert.ok(!result.drifts.some((d) => d.slug === 'company-creator'), 'company-creator copies must be identical');

    const paperclip = result.duplicates.find((d) => d.slug === 'paperclip');
    assert.ok(paperclip, 'expected paperclip duplicate to be tracked');
    assert.ok(!result.drifts.some((d) => d.slug === 'paperclip'), 'paperclip copies must be identical');
  });
});
