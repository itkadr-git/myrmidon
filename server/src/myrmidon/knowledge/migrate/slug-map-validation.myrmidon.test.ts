import { describe, expect, it } from "vitest";
import { MigrateInputError, parseSlugMap, serializeSlugMap } from "./map.js";

const page = { class: "A", action: "import", target: "wiki/page" };
const map = (overrides: Record<string, unknown> = {}) => ({
  version: 1, expectedTotal: 1, pages: { "page.md": page }, ...overrides,
});
const withPage = (overrides: Record<string, unknown>) => map({ pages: { "page.md": { ...page, ...overrides } } });

describe("slug map validation", () => {
  it.each([
    ["null root", null, "Slug map must be a JSON object."],
    ["array root", [], "Slug map must be a JSON object."],
    ["string version", map({ version: "1" }), "Slug map version must be 1."],
    ...[0, -1, 1.5, "1"].map((value): [string, unknown, string] => ["invalid expectedTotal " + value, map({ expectedTotal: value }), "Slug map expectedTotal must be a positive integer."]),
    ["array pages", map({ pages: [] }), "Slug map pages must be an object keyed by source path."],
    ["null page", map({ pages: { "page.md": null } }), 'Slug map page "page.md" must be an object.'],
    ["unknown action", withPage({ action: "invalid" }), 'Slug map page "page.md" has an unknown action.'],
    ["blank target", withPage({ target: "  " }), 'pages["page.md"].target must be a non-empty string.'],
    ["missing target", withPage({ target: undefined }), 'pages["page.md"] action "import" needs a target.'],
    ["sources not array", withPage({ sources: "source" }), 'pages["page.md"].sources must be an array.'],
    ["blank source", withPage({ sources: [" "] }), 'pages["page.md"].sources[] must be a non-empty string.'],
    ["tags not array", withPage({ tags: "tag" }), 'pages["page.md"].tags must be an array.'],
    ["blank tag", withPage({ tags: [" "] }), 'pages["page.md"].tags[] must be a non-empty string.'],
    ["checks not array", map({ checks: {} }), "Slug map checks must be an array."],
    ["null check", map({ checks: [null] }), "checks[0] must be an object."],
    ["blank query", map({ checks: [{ query: " ", expect: "page" }] }), "checks[0].query must be a non-empty string."],
    ["blank expect", map({ checks: [{ query: "page", expect: " " }] }), "checks[0].expect must be a non-empty string."],
  ])("rejects %s with a precise input error", (_name, input, message) => {
    const parse = () => parseSlugMap(JSON.stringify(input));
    expect(parse).toThrow(MigrateInputError);
    expect(parse).toThrowError(message as string);
  });

  it("accepts drop and mergeInto without target and trims optional strings", () => {
    const result = parseSlugMap(JSON.stringify(map({
      defaultSources: [" source "], ignored: true,
      pages: {
        drop: { class: "E", action: "drop", approverKind: null, ignored: true },
        merge: { class: "C", action: "merge", mergeInto: " destination ", kind: " wiki ", approverKind: " owner ", sources: [" ref "], tags: [" tag "], title: " Title " },
      },
      checks: [{ query: " query ", expect: " destination " }],
    })));
    expect(result).toEqual({
      version: 1, expectedTotal: 1, defaultSources: ["source"],
      pages: {
        drop: { class: "E", action: "drop", approverKind: null },
        merge: { class: "C", action: "merge", mergeInto: "destination", kind: "wiki", approverKind: "owner", sources: ["ref"], tags: ["tag"], title: "Title" },
      },
      checks: [{ query: "query", expect: "destination" }],
    });
  });

  it.each([[true, true], [false, false], [1, false], ["true", false], [null, false]])(
    "accepts only literal true for publish: %s", (value, expected) => {
      expect(parseSlugMap(JSON.stringify(withPage({ publish: value }))).pages["page.md"]?.publish).toBe(expected);
    },
  );

  it("round-trips all optional fields and serializes sorted paths without mutation", () => {
    const input = parseSlugMap(JSON.stringify(map({
      defaultSources: ["default"],
      pages: {
        "z.md": { class: "B", action: "import", target: "rules/z", kind: "rule", mergeInto: "rules/base", approverKind: null, publish: true, sources: ["ref"], tags: ["tag"], title: "Title" },
        "a.md": { class: "E", action: "drop" },
      },
      checks: [{ query: "rule", expect: "rules/z" }],
    })));
    const before = structuredClone(input);
    const serialized = serializeSlugMap(input);
    expect(Object.keys(JSON.parse(serialized).pages)).toEqual(["a.md", "z.md"]);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized.endsWith("\n\n")).toBe(false);
    expect(serializeSlugMap(input)).toBe(serialized);
    expect(input).toEqual(before);
    expect(parseSlugMap(serialized)).toEqual(before);
  });
});
