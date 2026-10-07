// server/src/myrmidon/skill-backimport/policy.myrmidon.test.ts
//
// myrmidon(1.6.5-SKILL-BACKIMPORT): the policy half of the back-import —
// which directories of a bot's skills root are bot-authored skills worth
// importing into the company catalog, and what they become. No driver, no
// database: every input is a plain value.

import { describe, expect, it } from "vitest";
import {
  buildBackImportInventory,
  classifyBackImportFileKind,
  classifyBotSkillFiles,
  deriveBackImportTrustLevel,
  normalizeBackImportSlug,
  SKILL_BACKUP_PREFIX,
} from "./policy.js";

const COMPANY = "10000000-0000-4000-8000-000000000001";

const SKILL_MD = [
  "---",
  "name: Vendor Triage",
  "description: Classifies vendor replies into a queue.",
  "---",
  "",
  "Read the reply, decide the queue, move the ticket.",
].join("\n");

describe("normalizeBackImportSlug", () => {
  it("keeps a slugged name", () => {
    expect(normalizeBackImportSlug("vendor-triage")).toBe("vendor-triage");
  });

  it("derives a slug from a display name", () => {
    expect(normalizeBackImportSlug("Vendor Triage!")).toBe("vendor-triage");
  });

  it("returns null when nothing usable remains", () => {
    expect(normalizeBackImportSlug("!!!")).toBeNull();
    expect(normalizeBackImportSlug(null)).toBeNull();
  });
});

describe("classifyBotSkillFiles", () => {
  it("imports a directory with a SKILL.md as a company-local skill", () => {
    const result = classifyBotSkillFiles({
      companyId: COMPANY,
      files: [
        { path: "vendor-triage/SKILL.md", content: SKILL_MD },
        { path: "vendor-triage/references/queues.md", content: "# Queues" },
      ],
      existingKeys: new Set(),
      existingSlugs: new Set(),
    });
    expect(result.skipped).toEqual([]);
    expect(result.skills).toHaveLength(1);
    const skill = result.skills[0]!;
    expect(skill.key).toBe(`company/${COMPANY}/vendor-triage`);
    expect(skill.slug).toBe("vendor-triage");
    expect(skill.name).toBe("Vendor Triage");
    expect(skill.description).toBe("Classifies vendor replies into a queue.");
    expect(skill.markdown).toBe(SKILL_MD);
  });

  it("never imports the pre-migration backup directory", () => {
    const result = classifyBotSkillFiles({
      companyId: COMPANY,
      files: [{ path: `${SKILL_BACKUP_PREFIX}old-skill/SKILL.md`, content: SKILL_MD }],
      existingKeys: new Set(),
      existingSlugs: new Set(),
    });
    expect(result.skills).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("skips a skill the catalog already has (the board's own delivered copy)", () => {
    const result = classifyBotSkillFiles({
      companyId: COMPANY,
      files: [{ path: "vendor-triage/SKILL.md", content: SKILL_MD }],
      existingKeys: new Set([`company/${COMPANY}/vendor-triage`]),
      existingSlugs: new Set(["vendor-triage"]),
    });
    expect(result.skills).toEqual([]);
  });

  it("skips a slug collision with another catalog skill", () => {
    const result = classifyBotSkillFiles({
      companyId: COMPANY,
      files: [{ path: "vendor-triage/SKILL.md", content: SKILL_MD }],
      existingKeys: new Set(["github/acme/vendor-triage"]),
      existingSlugs: new Set(["vendor-triage"]),
    });
    expect(result.skills).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain("already used");
  });

  it("skips a directory without a SKILL.md and one without a name", () => {
    const result = classifyBotSkillFiles({
      companyId: COMPANY,
      files: [
        { path: "notes/readme.md", content: "# notes" },
        { path: "nameless/SKILL.md", content: "---\ndescription: no name\n---\nbody" },
      ],
      existingKeys: new Set(),
      existingSlugs: new Set(),
    });
    expect(result.skills).toEqual([]);
    expect(result.skipped).toHaveLength(2);
  });

  it("ignores files at the skills root itself", () => {
    const result = classifyBotSkillFiles({
      companyId: COMPANY,
      files: [{ path: "SKILL.md", content: SKILL_MD }],
      existingKeys: new Set(),
      existingSlugs: new Set(),
    });
    expect(result.skills).toEqual([]);
  });
});

describe("inventory classification", () => {
  it("classifies the skill doc, references, scripts and assets like the catalog", () => {
    expect(classifyBackImportFileKind("SKILL.md")).toBe("skill");
    expect(classifyBackImportFileKind("references/a.md")).toBe("reference");
    expect(classifyBackImportFileKind("scripts/run.sh")).toBe("script");
    expect(classifyBackImportFileKind("assets/logo.png")).toBe("asset");
    expect(classifyBackImportFileKind("loose.md")).toBe("markdown");
    expect(classifyBackImportFileKind("loose.py")).toBe("script");
    expect(classifyBackImportFileKind("data.bin")).toBe("other");
  });

  it("derives the trust level from the inventory", () => {
    expect(deriveBackImportTrustLevel([{ kind: "skill" }, { kind: "markdown" }])).toBe("markdown_only");
    expect(deriveBackImportTrustLevel([{ kind: "skill" }, { kind: "asset" }])).toBe("assets");
    expect(deriveBackImportTrustLevel([{ kind: "skill" }, { kind: "script" }])).toBe("scripts_executables");
  });

  it("builds a sorted inventory with contents", () => {
    const inventory = buildBackImportInventory({
      key: "k",
      slug: "s",
      name: "n",
      description: null,
      markdown: SKILL_MD,
      directory: "vendor-triage",
      files: [
        { path: "scripts/run.sh", content: "#!/bin/sh" },
        { path: "SKILL.md", content: SKILL_MD },
      ],
    });
    expect(inventory.map((entry) => entry.path)).toEqual(["SKILL.md", "scripts/run.sh"]);
    expect(inventory[0]!.kind).toBe("skill");
    expect(inventory[1]!.kind).toBe("script");
  });
});
