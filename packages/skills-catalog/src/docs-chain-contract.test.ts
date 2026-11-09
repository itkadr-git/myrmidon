import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readRepoFile(path: string) {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

describe("docs-chain contract", () => {
  it("keeps .agents/skills/doc-maintenance/SKILL.md wired with Docs chain section and required markers", () => {
    const skill = readRepoFile(".agents/skills/doc-maintenance/SKILL.md");

    expect(skill).toMatch(/## Docs chain/i);
    expect(skill).toContain("EN docs task");
    expect(skill).toContain("RU changed sections");
    expect(skill).toContain("no auto-merge");
  });

  it("keeps doc/DOCS-CHAIN.md runbook with triggers, EN and RU task templates, and constraints", () => {
    const runbook = readRepoFile("doc/DOCS-CHAIN.md");

    // Templates
    expect(runbook).toMatch(/###? (.*Шаблон EN-задачи|.*EN [Dd]ocs [Tt]ask [Tt]emplate)/);
    expect(runbook).toMatch(/###? (.*Шаблон RU-задачи|.*RU [Cc]hanged [Ss]ections [Tt]ask [Tt]emplate)/);

    // Mandatory fields
    expect(runbook).toContain("Source PR");
    expect(runbook).toMatch(/список изменённых разделов|Changed sections/i);
    expect(runbook).toContain("переведены только изменённые разделы, ссылка на PR есть");

    // Safety and operational constraints
    expect(runbook).toMatch(/запрет автослияния|no auto-merge|автослияния нет/i);
    expect(runbook).toMatch(/лимит запусков|run limit/i);
    expect(runbook).toMatch(/ревью обязательно|review required/i);
  });
});
