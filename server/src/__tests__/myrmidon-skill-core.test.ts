import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// OPE-11947: the bot-facing Myrmidon skill is loaded into the context of every
// run, so its SKILL.md is a compact core and the detail lives in references/.
// These guards keep the core small and keep the core and its index honest.
// skills/paperclip is a symlink to skills/myrmidon (the frozen skills-releases/
// snapshots are never touched here).

const skillDir = fileURLToPath(new URL("../../../skills/myrmidon/", import.meta.url));
const referencesDir = path.join(skillDir, "references");
const core = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");

// A skill_view result larger than this is cheaper to avoid than to compact; the
// core was 62,839 bytes before OPE-11947.
const CORE_MAX_CHARS = 10_000;

// References that are intentionally not listed in the core index: language
// variants and the ADM-only instructions, which nothing in the core points at.
const UNINDEXED_REFERENCES = new Set([
  "adm-instructions.md",
  "adm-instructions.ru.md",
  "owner-dialogue.ru.md",
]);

function indexedReferences(): string[] {
  const index = core.slice(core.indexOf("## Where to read more"));
  return [...new Set([...index.matchAll(/`([a-z0-9-]+\.md)`/g)].map((match) => match[1]!))];
}

describe("myrmidon skill core", () => {
  it("keeps the skill entry point and frontmatter name intact", () => {
    expect(core.startsWith("---\nname: myrmidon\ndescription: >\n")).toBe(true);
    expect(core).toContain("\n# Myrmidon Skill\n");
  });

  it(`stays within ${CORE_MAX_CHARS} characters`, () => {
    expect(core.length).toBeLessThanOrEqual(CORE_MAX_CHARS);
  });

  it("tells the agent to load the skill once and never print full board JSON", () => {
    const normalized = core.replace(/\s+/g, " ");
    expect(normalized).toContain("Load this skill once per run");
    expect(normalized).toContain("Never re-open it after context compaction");
    expect(normalized).toContain("paperclip-managed:myrmidon");
    expect(normalized).toContain("paperclip-managed/myrmidon");
    expect(normalized).toContain("Never print full board JSON");
    expect(normalized).toContain("jq");
    expect(normalized).toContain("?limit=N");
    expect(normalized).toContain("Prefer: return=minimal");
  });

  it("keeps the run-audit header, checkout and final-disposition contract in the core", () => {
    expect(core).toContain('-H "X-Paperclip-Run-Id: $MYRMIDON_RUN_ID"');
    expect(core).toContain("POST /api/issues/{id}/checkout");
    expect(core).toContain("never retry a 409");
    expect(core).toContain("## Final disposition");
    for (const status of ["done", "in_review", "blocked", "in_progress"]) {
      expect(core).toContain(`\`${status}\``);
    }
    expect(core).toContain("blockedByIssueIds");
    expect(core).toContain("monitorNextCheckAt");
    expect(core).toContain("Generated Artifacts and Work Products");
    expect(core).toContain("references/artifacts.md");
    expect(core).toContain("Co-Authored-By: Myrmidon <noreply@myrmidon.ing>");
  });

  it("lists every relocated reference in the index and links no missing file", () => {
    const indexed = indexedReferences();
    expect(indexed.length).toBeGreaterThan(10);
    for (const name of indexed) {
      expect(existsSync(path.join(referencesDir, name)), `${name} is in the index but missing`).toBe(true);
    }
    const onDisk = readdirSync(referencesDir).filter((name) => name.endsWith(".md"));
    for (const name of onDisk) {
      if (UNINDEXED_REFERENCES.has(name)) continue;
      expect(indexed, `${name} is not reachable from the core index`).toContain(name);
    }
  });

  it("keeps the relocated sections out of the core", () => {
    for (const heading of [
      "## Issue-Thread Interactions",
      "### Standalone Decisions",
      "## MCP Tool Approval Gates",
      "## Key Endpoints (Hot Routes)",
      "### Pheromone Strength and Task Caste (1.6.5 F-27)",
    ]) {
      expect(core).not.toContain(heading);
      const holders = readdirSync(referencesDir)
        .filter((name) => name.endsWith(".md"))
        .filter((name) => readFileSync(path.join(referencesDir, name), "utf8").includes(`\n${heading}\n`));
      expect(holders, `${heading} must live in exactly one reference`).toHaveLength(1);
    }
  });

  it("enforces review discipline reference rules, indexing, and key markers", () => {
    const disciplineFile = "review-discipline.md";
    const disciplinePath = path.join(referencesDir, disciplineFile);
    expect(existsSync(disciplinePath), `${disciplineFile} must exist`).toBe(true);
    expect(indexedReferences()).toContain(disciplineFile);

    const content = readFileSync(disciplinePath, "utf8");
    // Reference exists and indexed; contains key rule markers:
    // 1. Current head / текущая голова
    expect(content).toMatch(/current head|текущ(ая|ей) голов/i);
    // 2. Proof / evidence / доказательство
    expect(content).toMatch(/proof|evidence|доказательств/i);
    // 3. Nit / non-blocking suggestions
    expect(content).toMatch(/\bnit\b/i);
    // 4. APPROVE rule / APPROVE-правило
    expect(content).toMatch(/APPROVE/);

    // Links to api-reference and heartbeat-procedure, and status PATCH mechanism
    expect(content).toContain("api-reference.md");
    expect(content).toContain("heartbeat-procedure.md");
    expect(content).toContain("PATCH /api/issues/");
  });
});
