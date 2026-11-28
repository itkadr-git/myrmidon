import { describe, expect, it } from "vitest";
import { assertSingleLine, assertValidSlug, assertValidTags, KnowledgeDomainError } from "./domain.js";

function expectRefusal(run: () => void, code: string): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(KnowledgeDomainError);
  expect(error).toMatchObject({ code, status: 400 });
}

describe("knowledge metadata boundaries", () => {
  it.each(["a", "0", "a-b/c_d"])("accepts slug %j", (slug) => {
    expect(() => assertValidSlug(slug)).not.toThrow();
  });

  it.each(["", "/a", "a/", "a//b", "A", "a.b", "a b", "a\rb", "a\nb", "a\r", "a\n"])(
    "rejects slug %j with invalid_slug",
    (slug) => expectRefusal(() => assertValidSlug(slug), "invalid_slug"),
  );

  it.each(["\u0417\u0430\u0433\u043e\u043b\u043e\u0432\u043e\u043a", " ", "  title with spaces  "])(
    "accepts single-line metadata %j",
    (value) => expect(() => assertSingleLine(value, "title")).not.toThrow(),
  );

  it.each(["", "a\rb", "a\nb", "\r", "\n"])("rejects metadata %j", (value) => {
    expectRefusal(() => assertSingleLine(value, "title"), "invalid_metadata");
  });

  it.each([
    { values: [] },
    { values: ["\u0437\u043d\u0430\u043d\u0438\u0435", "\u65e5\u672c\u8a9e"] },
    { values: ["first", " second "] },
  ])(
    "accepts frozen tags without mutation: $values",
    ({ values }) => {
      const tags = Object.freeze([...values]);
      expect(() => assertValidTags(tags)).not.toThrow();
      expect(tags).toEqual(values);
    },
  );

  it.each(["", "a,b", "a;b", "a\rb", "a\nb"])("rejects frozen tag %j without mutation", (tag) => {
    const tags = Object.freeze(["valid", tag]);
    expectRefusal(() => assertValidTags(tags), "invalid_metadata");
    expect(tags).toEqual(["valid", tag]);
  });
});
