import { describe, expect, it } from "vitest";
import type { KnowledgeTreeDoc, KnowledgeTreePage } from "./domain.js";
import { buildKnowledgeGitTree } from "./git-export.js";

function page(slug: string): KnowledgeTreePage {
  return {
    slug, title: slug, summary: null, kind: "wiki", folder: "ops", tags: [], roles: [],
    status: "published", approvalRequired: false, approverKind: null, content: "body\n",
  };
}

function doc(slugs: string[]): KnowledgeTreeDoc {
  return { nestId: "nest-1", pages: slugs.map(page) };
}

describe("knowledge export path collisions", () => {
  it.each([
    ["ops/a", "ops/a.md", "ops/a.md"],
    ["README", "README-page", "README-page.md"],
    ["README.md", "README-page.md", "README-page.md"],
  ])("rejects %s and %s in either order", (a, b, path) => {
    for (const slugs of [[a, b], [b, a]]) {
      expect(() => buildKnowledgeGitTree(doc(slugs))).toThrow(`Duplicate knowledge export path: ${path}`);
    }
  });

  it("preserves distinct pages regardless of input order", () => {
    const forward = buildKnowledgeGitTree(doc(["ops/a", "ops/b"]));
    const reverse = buildKnowledgeGitTree(doc(["ops/b", "ops/a"]));
    expect(forward).toEqual(reverse);
    expect(forward.files.map((file) => file.path)).toEqual(["README.md", "ops/a.md", "ops/b.md"]);
    expect(forward.files[1].content).toContain("slug: \"ops/a\"");
    expect(forward.files[2].content).toContain("slug: \"ops/b\"");
  });

  it("keeps the README page beside the generated README", () => {
    const tree = buildKnowledgeGitTree(doc(["README"]));
    expect(tree.files.map((file) => file.path)).toEqual(["README.md", "README-page.md"]);
    expect(tree.files[0].content).toContain("# Knowledge export");
    expect(tree.files[1].content).toContain("slug: \"README\"");
  });
});
