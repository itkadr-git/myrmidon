// ui/src/ui2/tests/ui2TopBarChipLabels.myrmidon.test.ts
//
// myrmidon(UI-2.0 Wave A part 2, §7.5): guard tests for the chip copy the
// top bar renders, through the REAL vendor i18next instance and the vendor
// locale JSON (the path the shell's useTranslation takes at runtime):
//   - the chip keys exist in both en and ru vendor catalogs with matching
//     placeholders (parity guarded by locale-validation for every file);
//   - budget-0 never renders an "of $0" part: the top bar picks
//     spendNoBudget when the model's budget is null;
//   - the Fleet chip keys are gone from the catalogs the top bar uses
//     (ia-v2 §3: убрать до MONITORING).

import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import ru from "@/i18n/locales/ru.json";
import { formatUi2Message } from "../i18n/locales";
import { ui2SpendChip, ui2RunsChip, ui2ColonyChip } from "../ui2TopBarChips";

type ChipCatalog = typeof en.ui2.chip;
const chipEn = en.ui2.chip as ChipCatalog;
const chipRu = ru.ui2.chip as ChipCatalog;

describe("myrmidon(UI2) top bar chip copy (vendor catalogs)", () => {
  it("carries the same chip key set in en and ru", () => {
    expect(Object.keys(chipEn).sort()).toEqual(Object.keys(chipRu).sort());
  });

  it("keeps interpolation placeholders identical between en and ru", () => {
    for (const key of Object.keys(chipEn) as Array<keyof ChipCatalog>) {
      const placeholders = (value: string) =>
        Array.from(value.matchAll(/{{\s*([A-Za-z0-9_.-]+)\s*}}/g), (match) => match[1]).sort();
      expect(placeholders(chipRu[key]), key).toEqual(placeholders(chipEn[key]));
    }
  });

  it("renders the colony chip from the template with real numbers", () => {
    const colony = ui2ColonyChip({ active: 61, running: 18, paused: 2, error: 1 });
    expect(formatUi2Message(chipEn.colony, { active: colony!.running, total: colony!.total })).toBe(
      "18 of 82",
    );
    expect(formatUi2Message(chipRu.colony, { active: colony!.running, total: colony!.total })).toBe(
      "18 из 82",
    );
  });

  it("renders the runs chip with and without today's failures", () => {
    const runs = { running: 21, failed: 56 };
    expect(formatUi2Message(chipEn.runsFailed, runs)).toBe("21 running · 56 failed today");
    expect(formatUi2Message(chipRu.runsFailed, runs)).toBe("21 в работе · 56 упали сегодня");
    expect(formatUi2Message(chipEn.runs, { running: 21 })).toBe("21 running");
    expect(formatUi2Message(chipRu.runs, { running: 21 })).toBe("21 в работе");
  });

  it("never renders 'of $0' when budgetCents = 0 (owner rule)", () => {
    const noBudget = ui2SpendChip({ companyId: "c", spendCents: 31_454, budgetCents: 0, utilizationPercent: 0 });
    // The top bar renders the raw money value when the budget part is null.
    const labelEn = noBudget!.budget
      ? formatUi2Message(chipEn.spend, { spend: noBudget!.spend, budget: noBudget!.budget })
      : noBudget!.spend;
    const labelRu = noBudget!.budget
      ? formatUi2Message(chipRu.spend, { spend: noBudget!.spend, budget: noBudget!.budget })
      : noBudget!.spend;
    expect(labelEn).toBe("$315");
    expect(labelRu).toBe("$315");
    expect(labelEn).not.toContain("of $0");
    expect(labelRu).not.toContain("из $0");
  });

  it("renders the budget part when a budget is set", () => {
    const withBudget = ui2SpendChip({ companyId: "c", spendCents: 157_400, budgetCents: 220_000, utilizationPercent: 71.5 });
    expect(
      formatUi2Message(chipEn.spend, { spend: withBudget!.spend, budget: withBudget!.budget! }),
    ).toBe("$1,574 of $2,200");
    expect(
      formatUi2Message(chipRu.spend, { spend: withBudget!.spend, budget: withBudget!.budget! }),
    ).toBe("$1,574 из $2,200");
  });

  it("the empty chip state is a dash in both languages (never a fake number)", () => {
    expect(chipEn.empty).toBe("—");
    expect(chipRu.empty).toBe("—");
  });

  it("the Fleet chip keys are removed (ia-v2 §3: no fleet metrics yet)", () => {
    expect(chipEn).not.toHaveProperty("fleet");
    expect(chipEn).not.toHaveProperty("fleetAttention");
    expect(chipRu).not.toHaveProperty("fleet");
    expect(chipRu).not.toHaveProperty("fleetAttention");
  });
});
