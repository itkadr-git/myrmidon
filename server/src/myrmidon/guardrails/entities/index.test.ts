import { describe, expect, it } from "vitest";
import { bankAccountMatchesBic, detectEntities } from "./index.js";

const matches = (text: string, entity: string) => detectEntities(text).filter((m) => m.entity === entity);

describe("entity recognizer", () => {
  it.each([
    ["Иванов Иван Иванович", "person_name"],
    ["+7 (999) 123-45-67", "phone"],
    ["user@example.com", "email"],
    ["4509 123456", "passport"],
    ["112-233-445 95", "snils"],
    ["40817810099910004312", "bank_account"],
    ["30101810400000000225", "correspondent_account"],
    ["044525225", "bic"],
    ["4111111111111111", "payment_card"],
    ["7707083893", "inn"],
    ["1027700132195", "ogrn"],
    ["304500100123456", "ogrnip"],
  ])("detects %s as %s", (value, entity) => {
    expect(matches(value, entity)).toHaveLength(1);
    expect(matches(value, entity)[0].score).toBeGreaterThan(0);
  });

  it("rejects a random 10-digit number as INN", () => {
    expect(matches("1234567890", "inn")).toHaveLength(0);
  });

  it("rejects a card that fails Luhn", () => {
    expect(matches("4111111111111112", "payment_card")).toHaveLength(0);
  });

  it("validates correspondent/account relation using BIC", () => {
    expect(bankAccountMatchesBic("30101810400000000225", "044525225")).toBe(true);
    expect(bankAccountMatchesBic("30101810400000000225", "044525226")).toBe(false);
  });

  it("supports a dictionary nest through a narrow interface", () => {
    const result = detectEntities("Секретное кодовое слово", {
      find: () => [{ value: "кодовое слово", start: 10, end: 23, score: 0.81 }],
    });
    expect(result).toContainEqual({ entity: "dictionary", value: "кодовое слово", score: 0.81, start: 10, end: 23 });
  });
});
