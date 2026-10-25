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
    ["304500100123451", "ogrnip"],
  ])("detects %s as %s", (value, entity) => {
    expect(matches(value, entity)).toHaveLength(1);
    expect(matches(value, entity)[0].score).toBeGreaterThan(0);
  });

  it("rejects a random 10-digit number as INN", () => {
    expect(matches("1234567890", "inn")).toHaveLength(0);
  });

  it("validates OGRN and OGRNIP check digits", () => {
    expect(matches("1027700132195", "ogrn")).toHaveLength(1);
    expect(matches("1027700132194", "ogrn")).toHaveLength(0);
    expect(matches("304500100123451", "ogrnip")).toHaveLength(1);
    expect(matches("304500100123456", "ogrnip")).toHaveLength(0);
  });

  it("rejects a card that fails Luhn", () => {
    expect(matches("4111111111111112", "payment_card")).toHaveLength(0);
  });

  it("validates correspondent/account relation using BIC", () => {
    expect(bankAccountMatchesBic("30101810400000000225", "044525225")).toBe(true);
    expect(bankAccountMatchesBic("30101810400000000225", "044525226")).toBe(false);
  });

  it.each([
    ["30101810400000000225", "044525225"],
    ["30101810400000000555", "044525225"],
    ["30101810000000000777", "044525225"],
  ])("accepts a valid correspondent-account/BIC pair: %s / %s", (account, bic) => {
    expect(bankAccountMatchesBic(account, bic)).toBe(true);
  });

  it.each([
    ["30101810400000000224", "044525225"],
    ["30101810400000000556", "044525225"],
    ["30101810000000000778", "044525225"],
  ])("rejects a pair with a changed check input: %s / %s", (account, bic) => {
    expect(bankAccountMatchesBic(account, bic)).toBe(false);
  });

  it("uses the settlement-account BIC suffix for non-correspondent accounts", () => {
    expect(bankAccountMatchesBic("40817810899910004312", "044525225")).toBe(true);
    expect(bankAccountMatchesBic("40817810899910004312", "044525226")).toBe(false);
  });

  it("does not classify labelled KPP as BIC for every supported separator", () => {
    for (const value of ["КПП: 770101001", "КПП :   770101001", "КПП - 770101001", "КПП № 770101001", "КПП    770101001", "KPP : 770101001"]) {
      expect(matches(value, "kpp"), value).toHaveLength(1);
      expect(matches(value, "bic"), value).toHaveLength(0);
    }
  });

  it("detects BIC labels without swallowing the following digits", () => {
    expect(matches("БИК:044525225", "bic")).toHaveLength(1);
    expect(matches("БИК 044525225", "bic")).toHaveLength(1);
    expect(matches("044525225", "bic")).toHaveLength(1);
    expect(matches("КПП 770101001, БИК:044525225", "bic")).toHaveLength(1);
  });

  it("matches Cyrillic names with Unicode-aware boundaries", () => {
    expect(matches("Иванов Иван Иванович", "person_name")).toHaveLength(1);
    expect(matches("Имя: Иванов Иван Иванович, клиент", "person_name")).toHaveLength(1);
    expect(matches("СуперИванов Иван Иванович", "person_name")).toHaveLength(1);
    expect(matches("ИвановXYZ Иван", "person_name")).toHaveLength(0);
  });

  it("distinguishes settlement and correspondent accounts by prefix", () => {
    expect(matches("40817810099910004312", "correspondent_account")).toHaveLength(0);
    expect(matches("30101810400000000225", "bank_account")).toHaveLength(0);
  });

  it("supports a dictionary nest through a narrow interface", () => {
    const result = detectEntities("Секретное кодовое слово", {
      find: () => [{ value: "кодовое слово", start: 10, end: 23, score: 0.81 }],
    });
    expect(result).toContainEqual({ entity: "dictionary", value: "кодовое слово", score: 0.81, start: 10, end: 23 });
  });
});
