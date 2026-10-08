// server/src/myrmidon/bot-containers/skill-backimport-archive.myrmidon.test.ts
//
// myrmidon(1.6.5-BOT-SKILL-BACKIMPORT, OPE-6401): the container-archive side of
// the back-import — skillDirectoriesFromArchive turns the Docker archive of
// hermes/skills into (name, files) directories, defensively. Pure: archives are
// built in memory with buildUstarArchive.

import { describe, expect, it } from "vitest";

import { skillDirectoriesFromArchive } from "./docker-driver.js";
import { buildUstarArchive, parseUstarArchive } from "./ustar.js";

const file = (path: string, content: string) => ({ path, type: "file" as const, content: Buffer.from(content, "utf8"), mode: 0o644, uid: 0, gid: 0 });
const dirEntry = (path: string) => ({ path, type: "directory" as const, content: Buffer.alloc(0), mode: 0o755, uid: 0, gid: 0 });

describe("skillDirectoriesFromArchive", () => {
  it("groups files by their skill directory under skills/", () => {
    const archive = buildUstarArchive([
      dirEntry("skills"),
      dirEntry("skills/deploy"),
      file("skills/deploy/SKILL.md", "---\nname: deploy\n---\n"),
      file("skills/deploy/references/steps.md", "steps"),
      dirEntry("skills/review"),
      file("skills/review/SKILL.md", "---\nname: review\n---\n"),
    ]);
    const skills = skillDirectoriesFromArchive(parseUstarArchive(archive));
    expect(skills.map((s) => s.name)).toEqual(["deploy", "review"]);
    const deploy = skills[0]!;
    expect(deploy.files.map((f) => f.path)).toEqual(["references/steps.md", "SKILL.md"]);
    expect(deploy.files.find((f) => f.path === "SKILL.md")?.content).toContain("name: deploy");
  });

  it("ignores entries outside skills/ and files directly at the skills root", () => {
    const archive = buildUstarArchive([
      file("skills-board/owned/SKILL.md", "board copy, never imported"),
      file("skills/loose.md", "not a skill"),
      file("skills/deploy/SKILL.md", "ok"),
    ]);
    const skills = skillDirectoriesFromArchive(parseUstarArchive(archive));
    expect(skills.map((s) => s.name)).toEqual(["deploy"]);
  });

  it("drops a skill with an unsafe path segment instead of importing it", () => {
    const archive = buildUstarArchive([
      file("skills/good/SKILL.md", "ok"),
      file("skills/bad/../../escape.md", "escape"),
    ]);
    const skills = skillDirectoriesFromArchive(parseUstarArchive(archive));
    expect(skills.map((s) => s.name)).toEqual(["good"]);
  });

  it("drops a skill containing a binary file (NUL byte)", () => {
    const archive = buildUstarArchive([
      file("skills/deploy/SKILL.md", "ok"),
      file("skills/deploy/blob.bin", "a\0b"),
    ]);
    expect(skillDirectoriesFromArchive(parseUstarArchive(archive))).toEqual([]);
  });

  it("caps the file count per skill", () => {
    const entries = [file("skills/fat/SKILL.md", "ok")];
    for (let i = 0; i < 250; i++) entries.push(file(`skills/fat/f${i}.md`, "x"));
    const skills = skillDirectoriesFromArchive(parseUstarArchive(buildUstarArchive(entries)));
    expect(skills).toEqual([]);
  });
});
