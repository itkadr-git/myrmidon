import { describe, expect, it } from "vitest";
import type { KnowledgeTreeDoc, KnowledgeTreePage } from "./domain.js";
import { buildKnowledgeGitTree, isLifeKnowledgePath, pagesForGitExport } from "./git-export.js";

function page(overrides: Partial<KnowledgeTreePage>): KnowledgeTreePage {
  return {
    slug: "ops/example",
    title: "Example",
    summary: null,
    kind: "wiki",
    folder: "ops",
    tags: [],
    roles: [],
    status: "published",
    approvalRequired: false,
    approverKind: null,
    content: "Synthetic public body\n",
    ...overrides,
  };
}

describe("knowledge export life segment boundary", () => {
  it.each([
    ["", "LiFe", true],
    [" directions / LiFe / notes ", "entry", true],
    ["public", " / archive / life / note / ", true],
    ["archive/life/private", "ordinary-slug", true],
    ["", "wildlife", false],
    ["lifecycle", "guide", false],
    ["life-notes", "public/life-notes", false],
    ["wildlife/lifecycle", "life-notes/entry", false],
  ])("classifies folder %j and slug %j as private: %s", (folder, slug, expected) => {
    expect(isLifeKnowledgePath(folder, slug)).toBe(expected);
  });

  it("exports only public pages in stable order without mutating input or exposing private data", () => {
    const publicZ = page({ slug: "wildlife/zebra", title: "Wildlife", folder: "wildlife" });
    const publicA = page({ slug: "life-notes/alpha", title: "Life notes", folder: "life-notes" });
    const publicM = page({ slug: "lifecycle/middle", title: "Lifecycle", folder: "lifecycle" });
    const privateFolder = page({ slug: "private-folder-slug", title: "Private Folder Title", folder: "archive/LiFe/notes", content: "Private Folder Body" });
    const privateSlug = page({ slug: "archive/life/private-slug-marker", title: "Private Slug Title", folder: "archive", content: "Private Slug Body" });
    const pages = [publicZ, privateFolder, publicM, privateSlug, publicA];
    const originalOrder = [...pages];
    const doc: KnowledgeTreeDoc = { nestId: "synthetic-nest", pages };

    expect(pagesForGitExport(doc)).toEqual([publicA, publicM, publicZ]);
    const tree = buildKnowledgeGitTree(doc);
    const reordered = buildKnowledgeGitTree({ ...doc, pages: [...pages].reverse() });
    expect(tree.pageCount).toBe(3);
    expect(tree.excludedLifePages).toBe(2);
    expect(tree.files.map((file) => file.path)).toEqual([
      "README.md",
      "life-notes/alpha.md",
      "lifecycle/middle.md",
      "wildlife/zebra.md",
    ]);
    expect(tree.files).toEqual(reordered.files);
    expect(tree.contentHash).toBe(reordered.contentHash);
    expect(pages).toEqual(originalOrder);
    originalOrder.forEach((original, index) => expect(pages[index]).toBe(original));

    const exported = tree.files.map((file) => `${file.path}\n${file.content}`).join("\n");
    for (const privateValue of [
      privateFolder.slug, privateFolder.title, privateFolder.content,
      privateSlug.slug, privateSlug.title, privateSlug.content,
    ]) {
      expect(exported).not.toContain(privateValue);
    }
    expect(exported).toContain("Synthetic public body");
    expect(exported).toContain("Wildlife");
    expect(exported).toContain("pages: 3");
  });
});
