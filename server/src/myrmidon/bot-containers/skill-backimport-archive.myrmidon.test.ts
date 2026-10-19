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

  it("accepts the Hermes category layout skills/<category>/<name>/SKILL.md", () => {
    // Review, point 1: on a live bot volume 63 of 65 skills sit in category
    // directories, including the ones the bot authored itself.
    const archive = buildUstarArchive([
      dirEntry("skills"),
      dirEntry("skills/devops"),
      dirEntry("skills/devops/deploy"),
      file("skills/devops/deploy/SKILL.md", "---\nname: deploy\n---\n"),
      file("skills/devops/deploy/references/steps.md", "steps"),
      dirEntry("skills/creative"),
      file("skills/creative/ascii-video/SKILL.md", "---\nname: ascii-video\n---\n"),
    ]);
    const skills = skillDirectoriesFromArchive(parseUstarArchive(archive));
    expect(skills.map((s) => s.name)).toEqual(["ascii-video", "deploy"]);
    const deploy = skills.find((s) => s.name === "deploy")!;
    expect(deploy.files.map((f) => f.path)).toEqual(["references/steps.md", "SKILL.md"]);
  });

  it("mixes flat and category layouts in one archive", () => {
    const archive = buildUstarArchive([
      file("skills/flat-skill/SKILL.md", "---\nname: flat-skill\n---\n"),
      file("skills/media/youtube-content/SKILL.md", "---\nname: youtube-content\n---\n"),
    ]);
    const skills = skillDirectoriesFromArchive(parseUstarArchive(archive));
    expect(skills.map((s) => s.name)).toEqual(["flat-skill", "youtube-content"]);
  });

  it("skips the ~60 bundled Hermes skills listed in skills/.bundled_manifest", () => {
    // Review, point 1: dropping the depth limit alone would import every
    // factory-bundled skill on the volume; the manifest names are the filter.
    const manifest = [
      "airtable:3b1f4e4c0e6aac15f2fd7f55e151bda9",
      "arxiv:1f2aed59cd49092c6dd1dc54272d7ccd",
      "youtube-content:deadbeef",
      "",
    ].join("\n");
    const archive = buildUstarArchive([
      file("skills/.bundled_manifest", manifest),
      // Bundled skills in both layouts must all be skipped.
      file("skills/airtable/SKILL.md", "bundled flat"),
      file("skills/arxiv/SKILL.md", "bundled flat"),
      file("skills/media/youtube-content/SKILL.md", "bundled in category"),
      file("skills/devops/deploy/SKILL.md", "authored, category layout"),
      file("skills/notes-taker/SKILL.md", "authored, flat"),
    ]);
    const skills = skillDirectoriesFromArchive(parseUstarArchive(archive));
    expect(skills.map((s) => s.name)).toEqual(["deploy", "notes-taker"]);
  });

  it("imports the bot's own skill even when a bundled skill shares its category", () => {
    const manifest = ["youtube-content:deadbeef"].join("\n");
    const archive = buildUstarArchive([
      file("skills/.bundled_manifest", manifest),
      file("skills/media/youtube-content/SKILL.md", "bundled"),
      file("skills/media/notes-taker/SKILL.md", "authored"),
    ]);
    const skills = skillDirectoriesFromArchive(parseUstarArchive(archive));
    expect(skills.map((s) => s.name)).toEqual(["notes-taker"]);
  });
});
