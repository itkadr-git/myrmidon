import { describe, expect, it } from "vitest";
import { addDefaultAliases, defaultAliasFromName } from "./addressing.js";

describe("default alias allocation", () => {
  it("reserves explicit aliases irrespective of case and whitespace", () => {
    const cards = [
      { name: "c-worker", aliases: [] },
      { name: "owner", aliases: [" Worker ", " WORKER-2 "] },
      { name: "a-worker", aliases: [] },
      { name: "b-worker", aliases: [] },
    ];
    const before = structuredClone(cards);
    const result = addDefaultAliases(cards);
    expect(result).toEqual([
      { name: "c-worker", aliases: ["worker-5"] },
      { name: "owner", aliases: [" Worker ", " WORKER-2 "] },
      { name: "a-worker", aliases: ["worker-3"] },
      { name: "b-worker", aliases: ["worker-4"] },
    ]);
    expect(cards).toEqual(before);
    expect(result).not.toBe(cards);
    expect(result[0]?.aliases).not.toBe(cards[0]?.aliases);
  });

  it("assigns collisions deterministically across input permutations", () => {
    const a = { name: "a-worker", aliases: [] as string[] };
    const b = { name: "b-worker", aliases: [] as string[] };
    const c = { name: "c-worker", aliases: [] as string[] };
    const permutations = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
    for (const cards of permutations) {
      const result = addDefaultAliases(cards);
      expect(Object.fromEntries(result.map(({ name, aliases }) => [name, aliases]))).toEqual({
        "a-worker": ["worker"],
        "b-worker": ["worker-2"],
        "c-worker": ["worker-3"],
      });
      expect(cards).toEqual(cards.map(({ name }) => ({ name, aliases: [] })));
    }
  });

  it("does not shadow another card name even when it has an explicit alias", () => {
    expect(addDefaultAliases([
      { name: "a-worker", aliases: [] },
      { name: " Worker ", aliases: ["lead"] },
    ])).toEqual([
      { name: "a-worker", aliases: ["worker-2"] },
      { name: " Worker ", aliases: ["lead"] },
    ]);
  });

  it("leaves cards without a usable default alias unchanged", () => {
    expect(defaultAliasFromName("team-!!!")).toBe("");
    const cards = [{ name: "team-!!!", aliases: [] as string[] }];
    expect(addDefaultAliases(cards)).toEqual([{ name: "team-!!!", aliases: [] }]);
    expect(cards).toEqual([{ name: "team-!!!", aliases: [] }]);
  });
});
