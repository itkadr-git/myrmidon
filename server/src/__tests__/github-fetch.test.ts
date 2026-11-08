import { describe, expect, it } from "vitest";
import {
  gitHubApiBase,
  isGitHubDotCom,
  resolveRawGitHubUrl,
} from "../services/github-fetch.js";

const SHA = "a".repeat(40);

describe("github fetch URL resolution", () => {
  it("detects github.com hosts including www and treats enterprise hosts separately", () => {
    expect(isGitHubDotCom("github.com")).toBe(true);
    expect(isGitHubDotCom("www.github.com")).toBe(true);
    expect(isGitHubDotCom("GITHUB.COM")).toBe(true);
    expect(isGitHubDotCom("github.example.corp")).toBe(false);
  });

  it("builds API bases for github.com and GitHub Enterprise", () => {
    expect(gitHubApiBase("github.com")).toBe("https://api.github.com");
    expect(gitHubApiBase("www.github.com")).toBe("https://api.github.com");
    expect(gitHubApiBase("github.example.corp")).toBe("https://github.example.corp/api/v3");
  });

  it("resolves raw content URLs against the exact ref it is given", () => {
    expect(resolveRawGitHubUrl("github.com", "acme", "skills", SHA, "SKILL.md"))
      .toBe(`https://raw.githubusercontent.com/acme/skills/${SHA}/SKILL.md`);
    expect(resolveRawGitHubUrl("github.com", "acme", "skills", "main", "nested/SKILL.md"))
      .toBe("https://raw.githubusercontent.com/acme/skills/main/nested/SKILL.md");
    expect(resolveRawGitHubUrl("github.example.corp", "acme", "skills", SHA, "dir/SKILL.md"))
      .toBe(`https://github.example.corp/raw/acme/skills/${SHA}/dir/SKILL.md`);
  });

  it("normalizes leading slashes in file paths without touching the ref", () => {
    expect(resolveRawGitHubUrl("github.com", "acme", "skills", SHA, "/deep/path/SKILL.md"))
      .toBe(`https://raw.githubusercontent.com/acme/skills/${SHA}/deep/path/SKILL.md`);
  });
});
