import { describe, expect, it } from "vitest";
import { defaultNestRedactConfig, redactText } from "./myrmidon-redact.js";

describe("nest redaction", () => {
  it("uses the nest dictionary and rules", () => {
    const config = defaultNestRedactConfig();
    config.counterparties = { "Acme LLC": "[COUNTERPARTY]" };
    expect(redactText("Acme LLC invoice 42", config).text).toBe("[COUNTERPARTY] invoice 42");
  });

  it("escapes regex metacharacters in dictionary keys", () => {
    const config = defaultNestRedactConfig();
    config.counterparties = { "A+B (test)": "[COUNTERPARTY]" };
    expect(redactText("A+B (test) and AB test", config).text).toBe("[COUNTERPARTY] and AB test");
  });

  it("keeps disabled rules untouched", () => {
    const config = defaultNestRedactConfig();
    config.rules.counterparties = false;
    config.counterparties = { Acme: "[X]" };
    expect(redactText("Acme", config).text).toBe("Acme");
  });
});
