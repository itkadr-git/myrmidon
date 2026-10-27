import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadDefaultAgentInstructionsBundle } from "./default-agent-instructions.js";

// Protocol header only: paths/identifiers are not platform branding.
const allowedTokens = ["X-Paperclip-Run-Id"];

function bareLegacyMentions(content: string) {
  let prose = content;
  for (const token of allowedTokens) prose = prose.replaceAll(token, "");
  return prose.match(/\bPaperclip\b/gi) ?? [];
}

describe("onboarding platform identity", () => {
  it("rejects bare legacy branding even beside an allowed protocol token", () => {
    expect(bareLegacyMentions("Use X-Paperclip-Run-Id")).toEqual([]);
    expect(bareLegacyMentions("Paperclip uses X-Paperclip-Run-Id")).toEqual(["Paperclip"]);
    expect(bareLegacyMentions("Welcome to PAPERCLIP!")).toEqual(["PAPERCLIP"]);
  });

  it("checks every onboarding asset recursively, including future bundles", async () => {
    const root = new URL("../onboarding-assets/", import.meta.url);
    const files = await fs.readdir(root, { recursive: true, withFileTypes: true });
    const violations: string[] = [];
    for (const file of files) {
      if (!file.isFile()) continue;
      const content = await fs.readFile(`${file.parentPath}/${file.name}`, "utf8");
      if (bareLegacyMentions(content).length) violations.push(`${file.parentPath}/${file.name}`);
    }
    expect(files.some((file) => file.name === "AGENTS.md")).toBe(true);
    expect(violations).toEqual([]);
  });

  it("loads Myrmidon identity and preserves the mutation protocol header", async () => {
    const defaults = await loadDefaultAgentInstructionsBundle("default");
    const ceo = await loadDefaultAgentInstructionsBundle("ceo");
    expect(defaults["AGENTS.md"]).toContain("Myrmidon");
    expect(defaults["AGENTS.md"]).toContain("X-Paperclip-Run-Id");
    expect(ceo["AGENTS.md"]).toContain("Myrmidon wake events");
    expect(ceo["HEARTBEAT.md"]).toContain("X-Paperclip-Run-Id");
  });
});
