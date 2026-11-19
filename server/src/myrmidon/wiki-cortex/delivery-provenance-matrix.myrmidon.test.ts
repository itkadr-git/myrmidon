import { describe, expect, it } from "vitest";
import type { ResolvedRule } from "../knowledge/rules.js";
import { approvedRegulationFromRule } from "./delivery.js";
import { renderRegulationsMarkdown } from "./render.js";

function deepFreeze(value: object): void {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") deepFreeze(child);
  }
}

function rules(): ResolvedRule[] {
  return [
    {
      pageId: "rules/zeta", slug: "rules/zeta", title: "Zeta", roles: ["engineer"], revisionNumber: 7,
      sources: [
        { kind: "task", ref: "TASK-4", note: "first" },
        { kind: "decision", ref: "DEC-2", note: null },
        { kind: "pr", ref: "PR-8", note: "last" },
      ],
      content: " \n  First line\n\n```ts\n  const x = 1;\n```\nLast line \n ",
    },
    {
      pageId: "rules/alpha", slug: "rules/alpha", title: "Alpha", roles: ["*"], revisionNumber: 2,
      sources: [{ kind: "pr", ref: "PR-3", note: null }, { kind: "decision", ref: "DEC-1", note: null }],
      content: "\n  Second rule\n  indented line  \n",
    },
    {
      pageId: "rules/middle", slug: "rules/middle", title: "Middle", roles: ["engineer"], revisionNumber: 11,
      sources: [], content: "  No provenance  ",
    },
  ];
}

describe("delivered regulation provenance matrix", () => {
  it("preserves each section's source, ordered provenance, and trimmed multiline content", () => {
    const input = rules();
    const before = structuredClone(input);
    deepFreeze(input);
    const mapped = input.map(approvedRegulationFromRule);
    const mappedBefore = structuredClone(mapped);
    deepFreeze(mapped);
    const markdown = renderRegulationsMarkdown(mapped);
    const sections = markdown.split(/^## /m).slice(1);

    expect(sections).toHaveLength(3);
    expect(sections[0]).toBe("Zeta\n\nSource: rules/zeta · revision 7\n\nProvenance: task:TASK-4, decision:DEC-2, pr:PR-8\n\nFirst line\n\n```ts\n  const x = 1;\n```\nLast line\n\n");
    expect(sections[1]).toBe("Alpha\n\nSource: rules/alpha · revision 2\n\nProvenance: pr:PR-3, decision:DEC-1\n\nSecond rule\n  indented line\n\n");
    expect(sections[2]).toBe("Middle\n\nSource: rules/middle · revision 11\n\nNo provenance\n");
    expect(sections[2]).not.toContain("Provenance:");
    expect((markdown.match(/^Source: /gm) ?? [])).toHaveLength(3);
    expect((markdown.match(/^Provenance: /gm) ?? [])).toHaveLength(2);
    expect(renderRegulationsMarkdown(mapped)).toBe(markdown);
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
    expect(input).toEqual(before);
    expect(mapped).toEqual(mappedBefore);
  });

  it("retains input order when rules and provenance are permuted", () => {
    const input = rules();
    input[0]!.sources.reverse();
    input.reverse();
    const before = structuredClone(input);
    deepFreeze(input);
    const markdown = renderRegulationsMarkdown(input.map(approvedRegulationFromRule));
    const sections = markdown.split(/^## /m).slice(1);
    expect(sections).toHaveLength(3);
    expect(sections.map((section) => section.split("\n")[0])).toEqual(["Middle", "Alpha", "Zeta"]);
    expect(sections[0]).not.toContain("Provenance:");
    expect(sections[2]).toContain("Provenance: pr:PR-8, decision:DEC-2, task:TASK-4\n");
    expect(sections[2]).not.toContain("Provenance: task:TASK-4, decision:DEC-2, pr:PR-8");
    expect(input).toEqual(before);
  });
});
