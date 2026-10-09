// myrmidon(1.6.5 OPE-6318 part D): the Telegram section's data layer — the
// default-alias mirror of the bridge rule, the metadata readers, and the patch
// builder that must keep every OTHER metadata key intact.

import { describe, expect, it } from "vitest";
import {
  buildTelegramMetadataPatch,
  collectTelegramGroupOptions,
  defaultTelegramAliasFromName,
  isValidTelegramAlias,
  normalizeTelegramAlias,
  readStoredTelegramAliases,
  readStoredTelegramGroup,
} from "./telegram-card-fields";

describe("defaultTelegramAliasFromName", () => {
  // CONSOLIDATION-OPE-6318: same expectations as the bridge's own rule.
  it("takes the last dash segment, lower-cased", () => {
    expect(defaultTelegramAliasFromName("adm-dev-eng-15")).toBe("15");
    expect(defaultTelegramAliasFromName("bbq-editor")).toBe("editor");
    expect(defaultTelegramAliasFromName("Wiki Maintainer")).toBe("wikimaintainer");
  });

  it("strips everything outside latin letters, digits and underscores", () => {
    expect(defaultTelegramAliasFromName("agent-my.boss!")).toBe("myboss");
  });

  it("yields empty for a tail with no latin character", () => {
    expect(defaultTelegramAliasFromName("Писатель")).toBe("");
    expect(defaultTelegramAliasFromName("")).toBe("");
  });
});

describe("alias normalization", () => {
  it("trims and lower-cases", () => {
    expect(normalizeTelegramAlias("  Eng-FIVE ")).toBe("eng-five");
  });

  it("accepts only lowercase latin letters, digits and underscores", () => {
    expect(isValidTelegramAlias("eng_5")).toBe(true);
    expect(isValidTelegramAlias("Eng")).toBe(false);
    expect(isValidTelegramAlias("eng-five")).toBe(false);
    expect(isValidTelegramAlias("писатель")).toBe(false);
    expect(isValidTelegramAlias("")).toBe(false);
  });
});

describe("metadata readers", () => {
  it("reads telegramAliases trimmed, lower-cased, deduplicated", () => {
    expect(readStoredTelegramAliases({ telegramAliases: [" Eng ", "eng", "x!"] })).toEqual([
      "eng",
      "x!",
    ]);
  });

  it("absent, non-array or broken metadata reads as null (no override)", () => {
    expect(readStoredTelegramAliases(null)).toBeNull();
    expect(readStoredTelegramAliases({})).toBeNull();
    expect(readStoredTelegramAliases({ telegramAliases: "eng" })).toBeNull();
    expect(readStoredTelegramAliases([])).toBeNull();
    expect(readStoredTelegramGroup(null)).toBeNull();
    expect(readStoredTelegramGroup({ telegramGroup: "   " })).toBeNull();
  });

  it("reads the group title trimmed", () => {
    expect(readStoredTelegramGroup({ telegramGroup: " Dispatch Squad " })).toBe("Dispatch Squad");
  });
});

describe("buildTelegramMetadataPatch", () => {
  it("keeps every unrelated metadata key", () => {
    const stored = { telegramAliases: ["old"], keeper: { a: 1 }, builtInAgent: { key: "x" } };
    const patch = buildTelegramMetadataPatch(stored, { aliases: ["five"], group: "Tooling" });
    expect(patch).toEqual({
      keeper: { a: 1 },
      builtInAgent: { key: "x" },
      telegramAliases: ["five"],
      telegramGroup: "Tooling",
    });
  });

  it("empty aliases and blank group clear only their own keys", () => {
    const stored = { telegramAliases: ["old"], telegramGroup: "G", keeper: 2 };
    expect(buildTelegramMetadataPatch(stored, { aliases: [], group: "  " })).toEqual({ keeper: 2 });
  });

  it("tolerates absent metadata", () => {
    expect(buildTelegramMetadataPatch(null, { aliases: ["eng"], group: null })).toEqual({
      telegramAliases: ["eng"],
    });
  });
});

describe("collectTelegramGroupOptions", () => {
  it("deduplicates and sorts the company's group titles", () => {
    const options = collectTelegramGroupOptions([
      { metadata: { telegramGroup: "Tooling" } },
      { metadata: { telegramGroup: "  Tooling  " } },
      { metadata: { telegramGroup: "Board" } },
      { metadata: { telegramGroup: "" } },
      { metadata: null },
    ]);
    expect(options).toEqual(["Board", "Tooling"]);
  });
});
