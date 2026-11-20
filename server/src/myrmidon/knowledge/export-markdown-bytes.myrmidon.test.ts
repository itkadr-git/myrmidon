import { describe, expect, it } from "vitest";
import type { KnowledgeTreePage } from "./domain.js";
import { renderKnowledgePageMarkdown } from "./git-export.js";

const page = (overrides: Partial<KnowledgeTreePage>): KnowledgeTreePage => ({
  slug: "ops/runbook",
  kind: "wiki",
  title: "Runbook",
  summary: null,
  folder: "ops",
  tags: ["oncall"],
  roles: [],
  status: "published",
  approvalRequired: false,
  approverKind: null,
  content: "",
  ...overrides,
});

describe("knowledge export markdown bytes", () => {
  it.each([
    {
      name: "null metadata and empty body",
      input: page({}),
      expected: '---\nslug: "ops/runbook"\nkind: "wiki"\ntitle: "Runbook"\nsummary: null\nfolder: "ops"\ntags: ["oncall"]\nstatus: "published"\napproval_required: false\napprover_kind: null\n---\n\n',
      wrong: '---\nslug: "ops/runbook"\nkind: "wiki"\ntitle: "Runbook"\nsummary: ""\nfolder: "ops"\ntags: ["oncall"]\nstatus: "published"\napproval_required: false\napprover_kind: ""\n---\n\n',
    },
    {
      name: "empty metadata and body without final LF",
      input: page({ summary: "", approverKind: "", approvalRequired: true, content: "one\ntwo" }),
      expected: '---\nslug: "ops/runbook"\nkind: "wiki"\ntitle: "Runbook"\nsummary: ""\nfolder: "ops"\ntags: ["oncall"]\nstatus: "published"\napproval_required: true\napprover_kind: ""\n---\n\none\ntwo\n',
      wrong: '---\nslug: "ops/runbook"\nkind: "wiki"\ntitle: "Runbook"\nsummary: ""\nfolder: "ops"\ntags: ["oncall"]\nstatus: "published"\napproval_required: true\napprover_kind: ""\n---\n\none\ntwo',
    },
    {
      name: "escaped Unicode fields and body with final LF",
      input: page({ title: 'Заголовок "да"\\путь\nстрока', summary: 'Кратко "да"\\путь\nстрока', tags: ['тег "да"\\путь\nстрока', "второй"], approverKind: "owner", approvalRequired: true, content: "тело\n---\nконец\n" }),
      expected: '---\nslug: "ops/runbook"\nkind: "wiki"\ntitle: "Заголовок \\"да\\"\\\\путь\\nстрока"\nsummary: "Кратко \\"да\\"\\\\путь\\nстрока"\nfolder: "ops"\ntags: ["тег \\"да\\"\\\\путь\\nстрока","второй"]\nstatus: "published"\napproval_required: true\napprover_kind: "owner"\n---\n\nтело\n---\nконец\n',
      wrong: '---\nslug: "ops/runbook"\nkind: "wiki"\ntitle: "Заголовок \\"да\\"\\\\путь\\nстрока"\nsummary: "Кратко \\"да\\"\\\\путь\\nстрока"\nfolder: "ops"\ntags: ["тег \\"да\\"\\\\путь\\nстрока","второй"]\nstatus: "published"\napproval_required: true\napprover_kind: "owner"\n---\n\nтело\n---\nконец\n\n',
    },
  ])("renders $name exactly and does not mutate the page", ({ input, expected, wrong }) => {
    const original = structuredClone(input);
    const originalTags = input.tags;
    const first = renderKnowledgePageMarkdown(input);
    const second = renderKnowledgePageMarkdown(input);

    expect(first).toBe(expected);
    expect(second).toBe(expected);
    expect(first).not.toBe(wrong);
    expect(input).toEqual(original);
    expect(input.tags).toBe(originalTags);
  });
});
