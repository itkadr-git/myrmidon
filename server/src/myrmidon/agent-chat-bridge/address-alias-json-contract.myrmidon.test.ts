import { describe, expect, it } from "vitest";
import { readTelegramAliases } from "./addressing.js";

describe("readTelegramAliases JSON contract", () => {
  it.each([
    ["null card", null],
    ["undefined card", undefined],
    ["string card", "aliases"],
    ["number card", 42],
    ["boolean card", false],
    ["array card", []],
    ["missing field", { other: ["A"] }],
    ["null field", { telegramAliases: null }],
    ["string field", { telegramAliases: "A" }],
    ["object field", { telegramAliases: { alias: "A" } }],
    ["number field", { telegramAliases: 42 }],
  ])("returns an empty array for %s", (_name, card) => {
    expect(readTelegramAliases(card)).toEqual([]);
  });

  it("trims entries and removes whitespace-only strings", () => {
    expect(readTelegramAliases({ telegramAliases: ["  first ", "\t", " second\n"] }))
      .toEqual(["first", "second"]);
  });

  it("lowercases Unicode without transliteration and preserves ASCII separators", () => {
    expect(readTelegramAliases({ telegramAliases: ["\u041c\u041e\u0421\u041a\u0412\u0410", "\u00c4LICE", "TEAM-Lead", "HELP_Desk"] }))
      .toEqual(["\u043c\u043e\u0441\u043a\u0432\u0430", "\u00e4lice", "team-lead", "help_desk"]);
  });

  it("deduplicates normalized aliases in first-occurrence order", () => {
    expect(readTelegramAliases({ telegramAliases: [" B ", "a", "b", " A ", "C", "c"] }))
      .toEqual(["b", "a", "c"]);
  });

  it("filters mixed entries without changing a deeply frozen card on repeated calls", () => {
    const nested = Object.freeze({ alias: "ignored" });
    const aliases = Object.freeze(["  ALPHA ", null, nested, 17, "beta", "alpha", " ", "BETA", "X-Y_Z"]);
    const card = Object.freeze({ telegramAliases: aliases, extra: Object.freeze({ keep: true }) });
    const original = { telegramAliases: ["  ALPHA ", null, { alias: "ignored" }, 17, "beta", "alpha", " ", "BETA", "X-Y_Z"], extra: { keep: true } };

    expect(readTelegramAliases(card)).toEqual(["alpha", "beta", "x-y_z"]);
    expect(readTelegramAliases(card)).toEqual(["alpha", "beta", "x-y_z"]);
    expect(card).toEqual(original);
  });
});
