import { describe, expect, it } from "vitest";
import { classifyPath, slugFor, slugSegment } from "./classify.js";

describe("classification precedence and boundaries", () => {
  it.each([
    ["regulations/log.md", 900, "F", "drop"],
    ["projects/x/index.md", 1, "D", "drop"],
    ["regulations/secrets.md", 1, "B", "import"],
    ["arch/x.md", 199, "E", "drop"],
    ["arch/x.md", 200, "C", "merge"],
    ["arch/x.md", 201, "C", "merge"],
    ["infra/x.md", 0, "A", "import"],
    ["regulations/log/archive/page.md", 900, "F", "drop"],
    ["arch/log-2026/nested/page.md", 900, "F", "drop"],
    ["arch/log.archive/page.md", 900, "F", "drop"],
  ])("classifies %s at %i bytes as %s/%s", (path, bytes, expectedClass, action) => {
    expect(classifyPath(path, bytes)).toMatchObject({ class: expectedClass, action });
  });

  it("does not mistake catalog or logbook for a log", () => {
    expect(() => classifyPath("catalog/logbook.md", 900)).toThrow(
      'Unclassified source path "catalog/logbook.md"; the slug map must decide.',
    );
  });
});

describe("knowledge slugs", () => {
  it.each([
    ["//Arch///Some Page.md", "arch/some-page"],
    ["arch/nested/index.md", "arch/nested"],
    ["index.md", "index"],
    ["", "page"],
    ["///", "page"],
  ])("derives slug for %s", (path, expected) => {
    expect(slugFor(path)).toBe(expected);
  });

  it.each([
    ["!!!", "page"],
    ["  HELLO World.MD  ", "hello-world"],
    ["  __Example_Name.TXT  ", "example_name"],
  ])("normalizes segment %s", (segment, expected) => {
    expect(slugSegment(segment)).toBe(expected);
  });
});
